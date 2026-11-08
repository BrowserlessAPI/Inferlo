/**
 * Inferlo jobs on BullMQ, without a runtime dependency on bullmq:
 *
 *   import { Queue, Worker } from "bullmq";
 *   import { bullmqJobStore } from "@browserlessapi/inferlo/bullmq";
 *
 *   const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };
 *   const queue = new Queue("inferlo", { connection });
 *   const worker = new Worker("inferlo", null, { connection, autorun: false });
 *   export const app = createApp({ jobs, jobQueue: { store: bullmqJobStore(queue, worker) } });
 *
 * Each Inferlo job is a BullMQ job in that queue (job name = Inferlo job name, job id = Inferlo job id), so BullMQ
 * dashboards show them. Inferlo takes jobs with BullMQ's manual processing API (worker.getNextJob with a token),
 * runs them with its own handlers, retries (moveToDelayed with Inferlo's backoff), tracing and tenants, and finishes
 * them with moveToCompleted or moveToFailed. While a job runs its lock is extended every lockDuration / 2; a job
 * whose lock expired (its process stopped) is moved back by BullMQ's stalled-job check and run again as its next
 * attempt, or failed when it has no attempts left.
 */
import { InferloError } from "./errors.ts";
import { STOPPED_MESSAGE, type JobRecord, type JobStore } from "./jobs.ts";

/** A BullMQ job: the parts Inferlo uses. */
export interface BullMQJob {
  id?: string;
  name: string;
  data: any;
  timestamp: number;
  delay?: number;
  processedOn?: number;
  finishedOn?: number;
  failedReason?: string;
  /** Times the job was moved to active, also after a stall (BullMQ 5 and later). */
  attemptsStarted?: number;
  getState(): Promise<string>;
  updateData(data: any): Promise<unknown>;
  extendLock(token: string, duration: number): Promise<unknown>;
  moveToCompleted(returnValue: any, token: string, fetchNext?: boolean): Promise<unknown>;
  moveToFailed(error: Error, token: string, fetchNext?: boolean): Promise<unknown>;
  moveToDelayed(timestamp: number, token?: string): Promise<unknown>;
}

/** A BullMQ Queue (new Queue(name, { connection })): the parts Inferlo uses. */
export interface BullMQQueue {
  readonly name: string;
  add(name: string, data: any, options?: any): Promise<unknown>;
  getJob(id: string): Promise<BullMQJob | undefined | null>;
}

/** A BullMQ Worker without a processor (new Worker(name, null, { connection, autorun: false })): the parts Inferlo uses. */
export interface BullMQWorker {
  readonly name: string;
  opts: { autorun?: boolean; lockDuration?: number; [key: string]: unknown };
  getNextJob(token: string, options?: { block?: boolean }): Promise<BullMQJob | undefined>;
  startStalledCheckTimer(): Promise<void>;
}

/** Finished (done or failed) jobs are kept this long in BullMQ (removeOnComplete and removeOnFail), as in the Redis store. */
export const BULLMQ_KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;
const NOT_INFERLO = "Not an Inferlo job: the queue given to bullmqJobStore() must hold only Inferlo jobs. Give Inferlo its own BullMQ queue.";

/** What Inferlo keeps in job.data. */
interface Data {
  inferlo: 1;
  input: unknown;
  maxAttempts: number;
  runAt: number;
  createdAt: number;
  trace?: { traceparent: string; tracestate?: string };
  tenantId?: string;
  lastError?: string;
  /** Attempts that ended (with a retry) so far: an attempt started but never ended was stopped. */
  ended?: number;
}

function isData(data: unknown): data is Data {
  const d = data as Partial<Data> | null;
  return !!d && typeof d === "object" && d.inferlo === 1 && typeof d.maxAttempts === "number" && typeof d.runAt === "number" && typeof d.createdAt === "number";
}

function invalid(why: string): InferloError {
  return new InferloError("IL6057", `Invalid bullmqJobStore() arguments: ${why}.`, {
    fix: 'Pass a BullMQ Queue and a Worker of the same queue without a processor: const queue = new Queue("inferlo", { connection }); const worker = new Worker("inferlo", null, { connection, autorun: false }); then createApp({ jobQueue: { store: bullmqJobStore(queue, worker) } }).',
  });
}

const fn = (value: unknown, name: string) => typeof (value as Record<string, unknown> | null)?.[name] === "function";

/** Attempts started so far: BullMQ counts each move to active, also after a stall. */
const attemptsOf = (job: BullMQJob): number => job.attemptsStarted ?? 0;

function toRecord(job: BullMQJob, data: Data, status: JobRecord["status"], attempts: number, updatedAt: number): JobRecord {
  const record: JobRecord = {
    id: String(job.id),
    name: job.name,
    input: data.input,
    status,
    attempts,
    maxAttempts: data.maxAttempts,
    runAt: new Date(data.runAt),
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(updatedAt),
  };
  if (data.lastError !== undefined) record.lastError = data.lastError;
  if (data.trace?.traceparent) record.trace = { ...data.trace };
  if (data.tenantId) record.tenantId = data.tenantId;
  return record;
}

const STATUS: Record<string, JobRecord["status"]> = { active: "running", completed: "done", failed: "failed" };

/**
 * A job store that keeps Inferlo jobs in a BullMQ queue: createApp({ jobQueue: { store: bullmqJobStore(queue, worker) } }).
 * The worker must belong to the same queue, have no processor and be created with autorun: false; Inferlo takes
 * jobs from it in app.jobs.start() and app.jobs.runDue(). Close the worker and the queue after app.close().
 */
export function bullmqJobStore(queue: BullMQQueue, worker: BullMQWorker): JobStore {
  if (!fn(queue, "add") || !fn(queue, "getJob") || typeof queue?.name !== "string") throw invalid("the first argument is not a BullMQ Queue");
  if (!fn(worker, "getNextJob") || !fn(worker, "startStalledCheckTimer") || typeof worker?.name !== "string") throw invalid("the second argument is not a BullMQ Worker");
  if (worker.name !== queue.name) throw invalid(`the worker reads queue "${worker.name}", not "${queue.name}"`);
  if (worker.opts?.autorun !== false) throw invalid("the worker must be created with autorun: false and no processor, so only Inferlo takes its jobs");
  const lockDuration = typeof worker.opts.lockDuration === "number" && worker.opts.lockDuration > 0 ? worker.opts.lockDuration : 30_000;
  const keepFor = { age: Math.round(BULLMQ_KEEP_FINISHED_MS / 1000) };
  // Jobs this process claimed: the token that holds their lock and the timer that extends it.
  const active = new Map<string, { job: BullMQJob; token: string; data: Data; attempts: number; timer: ReturnType<typeof setInterval> }>();
  let stalledCheck: Promise<void> | undefined;

  const release = (id: string) => {
    const claimed = active.get(id);
    if (claimed) clearInterval(claimed.timer);
    active.delete(id);
    return claimed;
  };

  return {
    queue: "bullmq",
    async add(r) {
      const data: Data = { inferlo: 1, input: r.input ?? null, maxAttempts: r.maxAttempts, runAt: r.runAt.getTime(), createdAt: r.createdAt.getTime() };
      if (r.trace?.traceparent) data.trace = r.trace.tracestate ? { traceparent: r.trace.traceparent, tracestate: r.trace.tracestate } : { traceparent: r.trace.traceparent };
      if (r.tenantId) data.tenantId = r.tenantId;
      if (r.lastError !== undefined) data.lastError = r.lastError;
      // BullMQ ignores a job whose id is already in the queue (cron ticks and event jobs use fixed ids).
      // Retries are Inferlo's (attempts: 1 in BullMQ), so the queue's defaultJobOptions cannot retry twice.
      await queue.add(r.name, data, { jobId: r.id, delay: Math.max(0, r.runAt.getTime() - Date.now()), attempts: 1, removeOnComplete: keepFor, removeOnFail: keepFor });
    },

    async claim(_now, limit, _names) {
      // BullMQ moves due delayed jobs and jobs of stopped workers itself, by its own clock.
      stalledCheck ??= worker.startStalledCheckTimer().catch(() => {});
      const out: JobRecord[] = [];
      while (out.length < limit) {
        const token = crypto.randomUUID();
        const job = await worker.getNextJob(token, { block: false });
        if (!job) break;
        if (!isData(job.data)) {
          await job.moveToFailed(new Error(NOT_INFERLO), token, false);
          continue;
        }
        const data: Data = { ...job.data };
        const attempts = attemptsOf(job);
        // An attempt that started but never ended: its worker stopped and BullMQ moved the job back.
        if (attempts - 1 > (data.ended ?? 0)) {
          data.lastError = STOPPED_MESSAGE;
          if (attempts > data.maxAttempts) {
            await job.moveToFailed(new Error(STOPPED_MESSAGE), token, false);
            continue;
          }
        }
        const timer = setInterval(() => void job.extendLock(token, lockDuration).catch(() => {}), Math.max(10, Math.floor(lockDuration / 2)));
        active.set(String(job.id), { job, token, data, attempts, timer });
        out.push(toRecord(job, data, "running", attempts, Date.now()));
      }
      return out;
    },

    async update(id, patch) {
      const claimed = release(id);
      if (!claimed) return;
      const { job, token, data, attempts } = claimed;
      if (patch.status === "done") {
        await job.moveToCompleted(null, token, false);
      } else if (patch.status === "failed") {
        await job.updateData({ ...data, ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}) });
        await job.moveToFailed(new Error(patch.lastError ?? data.lastError ?? "failed"), token, false);
      } else if (patch.status === "pending") {
        const runAt = (patch.runAt ?? new Date()).getTime();
        await job.updateData({ ...data, runAt, ended: attempts, ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}) });
        await job.moveToDelayed(runAt, token);
      }
    },

    async get(id) {
      const job = await queue.getJob(id);
      if (!job || !isData(job.data)) return null;
      const state = await job.getState();
      if (state === "unknown") return null;
      const status = STATUS[state] ?? "pending";
      const claimed = active.get(id);
      const data: Data = claimed ? claimed.data : job.data;
      const record = toRecord(job, data, status, claimed?.attempts ?? attemptsOf(job), job.finishedOn ?? job.processedOn ?? job.timestamp);
      if (status === "failed" && job.failedReason && record.lastError === undefined) record.lastError = job.failedReason;
      return record;
    },
  };
}
