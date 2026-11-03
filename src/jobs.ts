/**
 * Background jobs: work that runs after the request, with retries.
 *
 *   export const sendWelcome = job("send-welcome", { input: t.object({ userId: t.uuid() }) })
 *     .handle(async ({ input, db }) => { ... })
 *
 *   createApp({ jobs: [jobs] })                          // import * as jobs from "./jobs.ts"
 *   await ctx.jobs.enqueue(sendWelcome, { userId })      // in a route handler, validated
 *
 * Jobs are plain values like routes. The queue is kept by a JobStore; app.jobs.start() runs due
 * jobs in this process, app.jobs.runDue() runs them once (tests).
 */
import type { AI } from "./ai/index.ts";
import { InferloError } from "./errors.ts";
import type { AppDb } from "./route.ts";
import { ValidationError, type AnySchema, type Infer, type InferInput } from "./schema.ts";

export interface JobOptions<I extends AnySchema> {
  /** Schema of the job's input. Checked when the job is enqueued and again when it runs. */
  input: I;
  /** Extra attempts after a failure, with growing delays (10s, 20s, 40s, ... up to 1 hour). Default 3. */
  retries?: number;
  /** One line shown in describe. */
  summary?: string;
}

export interface JobContext<Input> {
  /** The validated input. */
  input: Input;
  db: AppDb;
  ai: AI;
  /** Enqueue follow-up jobs. */
  jobs: Jobs;
  /** Job id. */
  id: string;
  /** 1 on the first run, 2 on the first retry, and so on. */
  attempt: number;
}

export interface JobDef<Input = any, Output = any> {
  readonly kind: "inferlo.job";
  readonly name: string;
  readonly options: JobOptions<AnySchema>;
  readonly handler: (ctx: JobContext<Output>) => unknown;
  /** Type only: what enqueue accepts. */
  readonly $input?: Input;
}

/** What enqueue accepts for a job. */
export type JobInput<J> = J extends JobDef<infer I, any> ? I : never;

export interface EnqueueOptions {
  /** Run no earlier than this time. Default: now. */
  runAt?: Date;
}

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  name: string;
  /** The input as stored (JSON). */
  input: unknown;
  status: JobStatus;
  /** Runs started so far. */
  attempts: number;
  /** 1 + retries. */
  maxAttempts: number;
  /** When the job runs next (pending) or last ran. */
  runAt: Date;
  /** Message of the last failure. */
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Jobs {
  /** Validate the input and queue the job. Returns the queued record. */
  enqueue<J extends JobDef>(job: J, input: JobInput<J>, options?: EnqueueOptions): Promise<JobRecord>;
}

/** Where queued jobs are kept. */
export interface JobStore {
  add(record: JobRecord): Promise<void>;
  /** Mark up to limit pending jobs with runAt <= now as running (attempts + 1) and return them. */
  claim(now: Date, limit: number): Promise<JobRecord[]>;
  update(id: string, patch: Partial<Pick<JobRecord, "status" | "runAt" | "lastError">>): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
}

export interface RunResult {
  /** Jobs that finished. */
  done: number;
  /** Jobs that failed and will run again later. */
  retried: number;
  /** Jobs that failed for the last time. */
  failed: number;
}

export interface Worker {
  /** Stop polling and wait for running jobs to finish. */
  stop(): Promise<void>;
}

/** app.jobs: enqueue, inspect and run jobs. */
export interface AppJobs extends Jobs {
  /** The registered jobs. */
  readonly list: readonly JobDef[];
  /** A queued job by id, or null. */
  get(id: string): Promise<JobRecord | null>;
  /** Run every job that is due now (or at options.now), one after another, including follow-ups they enqueue, then return. For tests and scripts. */
  runDue(options?: { now?: Date }): Promise<RunResult>;
  /** Run due jobs in this process every pollMs (default 1000) until stop() is called. */
  start(options?: { pollMs?: number }): Worker;
}

const MAX_RETRIES = 25;
const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 3_600_000;

/** Delay before retry n (1-based): 10s, 20s, 40s, ... at most one hour. */
export function retryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

export class JobBuilder<I extends AnySchema> {
  readonly name: string;
  readonly options: JobOptions<I>;

  constructor(name: string, options: JobOptions<I>) {
    this.name = name;
    this.options = options;
  }

  /** The job's work. Throw to fail the attempt; it is retried until retries run out. */
  handle(handler: (ctx: JobContext<Infer<I>>) => unknown): JobDef<InferInput<I>, Infer<I>> {
    return { kind: "inferlo.job", name: this.name, options: this.options, handler: handler as JobDef["handler"] };
  }
}

const JOB_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** Define a background job: job("send-email", { input: t.object({ to: t.email() }) }).handle(fn). */
export function job<I extends AnySchema>(name: string, options: JobOptions<I>): JobBuilder<I> {
  checkJob(name, options);
  return new JobBuilder(name, options);
}

function checkJob(name: unknown, options: unknown): void {
  const o = options as JobOptions<AnySchema> | undefined;
  const problems: string[] = [];
  if (typeof name !== "string" || !JOB_NAME.test(name)) problems.push("the name must be lowercase letters, digits and dashes, starting with a letter");
  if (!o || typeof o !== "object") problems.push("options must be an object with an input schema");
  else {
    if (!o.input || typeof (o.input as AnySchema).safeParse !== "function") problems.push("input must be a schema such as t.object({ ... })");
    if (o.retries !== undefined && (!Number.isInteger(o.retries) || o.retries < 0 || o.retries > MAX_RETRIES)) problems.push(`retries must be a whole number from 0 to ${MAX_RETRIES}`);
  }
  if (problems.length) {
    throw new InferloError("IL6009", `Invalid job "${String(name)}": ${problems.join(", ")}.`, {
      fix: 'Use job("send-email", { input: t.object({ to: t.email() }), retries: 3 }).handle(async ({ input }) => { ... }).',
    });
  }
}

export function isJob(value: unknown): value is JobDef {
  return typeof value === "object" && value !== null && (value as JobDef).kind === "inferlo.job";
}

/** Anything that contains jobs: a job, an array, or a module (import * as jobs from "./jobs.ts"). */
export type JobSource = JobDef | readonly JobSource[] | { readonly [name: string]: unknown };

export function collectJobs(sources: readonly JobSource[] | undefined): JobDef[] {
  const out: JobDef[] = [];
  const seen = new Set<unknown>();
  const visit = (source: unknown) => {
    if (!source || typeof source !== "object" || seen.has(source)) return;
    seen.add(source);
    if (isJob(source)) out.push(source);
    else if (Array.isArray(source)) source.forEach(visit);
    else for (const value of Object.values(source)) if (isJob(value) || Array.isArray(value)) visit(value);
  };
  visit(sources);
  const names = new Map<string, JobDef>();
  for (const j of out) {
    if (names.has(j.name)) throw new InferloError("IL6009", `Two jobs are named "${j.name}".`, { fix: "Give each job a unique name." });
    names.set(j.name, j);
  }
  return out;
}

/** Jobs kept in this process. They are lost when it stops, so use it for development and tests. */
export function memoryJobStore(): JobStore {
  const records = new Map<string, JobRecord>();
  const copy = (r: JobRecord): JobRecord => ({ ...r, runAt: new Date(r.runAt), createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) });
  return {
    async add(record) {
      records.set(record.id, copy(record));
    },
    async claim(now, limit) {
      const due = [...records.values()]
        .filter((r) => r.status === "pending" && r.runAt.getTime() <= now.getTime())
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
        .slice(0, limit);
      for (const r of due) Object.assign(r, { status: "running", attempts: r.attempts + 1, updatedAt: new Date() });
      return due.map(copy);
    },
    async update(id, patch) {
      const r = records.get(id);
      if (r) Object.assign(r, patch, { updatedAt: new Date() });
    },
    async get(id) {
      const r = records.get(id);
      return r ? copy(r) : null;
    },
  };
}

export interface JobRuntime {
  db: AppDb;
  ai: AI;
  store: JobStore;
  logger: { info(message: string, data?: unknown): void; error(message: string, data?: unknown): void };
}

export function createJobs(list: readonly JobDef[], runtime: JobRuntime): AppJobs {
  const byName = new Map(list.map((j) => [j.name, j]));

  const registered = (j: JobDef): JobDef => {
    const found = isJob(j) ? byName.get(j.name) : undefined;
    if (!found) {
      const name = isJob(j) ? `"${j.name}"` : "This value";
      throw new InferloError("IL6010", `${name} is not a registered job.`, {
        fix: "Pass a job defined with job(...).handle(...) and add it (or its module) to createApp({ jobs: [...] }).",
      });
    }
    return found;
  };

  const parse = (j: JobDef, input: unknown): unknown => {
    const result = j.options.input.safeParse(input);
    if (!result.ok) throw new ValidationError(result.issues, `input for job "${j.name}"`);
    return result.value;
  };

  const jobs: AppJobs = {
    list,
    async enqueue(j, input, options = {}) {
      const def = registered(j);
      if (options.runAt !== undefined && (!(options.runAt instanceof Date) || Number.isNaN(options.runAt.getTime()))) {
        throw new InferloError("IL6009", `runAt for job "${def.name}" must be a valid Date.`, { fix: "Pass runAt: new Date(Date.now() + 60_000) or leave it out to run now." });
      }
      // Stored as JSON, so it survives a restart with a database store; parsed again when it runs.
      const stored = JSON.parse(JSON.stringify(parse(def, input) ?? null)) as unknown;
      const now = new Date();
      const record: JobRecord = {
        id: crypto.randomUUID(),
        name: def.name,
        input: stored,
        status: "pending",
        attempts: 0,
        maxAttempts: 1 + (def.options.retries ?? 3),
        runAt: options.runAt ?? now,
        createdAt: now,
        updatedAt: now,
      };
      await runtime.store.add(record);
      return record;
    },

    get: (id) => runtime.store.get(id),

    async runDue(options = {}) {
      const result: RunResult = { done: 0, retried: 0, failed: 0 };
      while (true) {
        // Without options.now, jobs enqueued by the jobs that run (follow-ups) run in the same call.
        const now = options.now ?? new Date();
        const [record] = await runtime.store.claim(now, 1);
        if (!record) return result;
        result[await run(record, now)]++;
      }
    },

    start(options = {}) {
      const pollMs = options.pollMs ?? 1000;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const loop = (async () => {
        while (!stopped) {
          try {
            await jobs.runDue();
          } catch (error) {
            runtime.logger.error("job worker error", error);
          }
          if (stopped) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, pollMs);
          });
        }
      })();
      return {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
          wake?.();
          await loop;
        },
      };
    },
  };

  async function run(record: JobRecord, now: Date): Promise<keyof RunResult> {
    const def = byName.get(record.name);
    try {
      if (!def) throw new InferloError("IL6010", `"${record.name}" is not a registered job.`, { fix: "Add the job to createApp({ jobs: [...] }) in the process that runs jobs." });
      await def.handler({ input: parse(def, record.input), db: runtime.db, ai: runtime.ai, jobs, id: record.id, attempt: record.attempts });
      await runtime.store.update(record.id, { status: "done" });
      return "done";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (record.attempts < record.maxAttempts) {
        await runtime.store.update(record.id, { status: "pending", lastError: message, runAt: new Date(now.getTime() + retryDelayMs(record.attempts)) });
        runtime.logger.error(`job "${record.name}" failed (attempt ${record.attempts} of ${record.maxAttempts}), will retry`, { id: record.id, error: message });
        return "retried";
      }
      await runtime.store.update(record.id, { status: "failed", lastError: message });
      runtime.logger.error(`job "${record.name}" failed after ${record.attempts} attempt(s)`, { id: record.id, error: message });
      return "failed";
    }
  }

  return jobs;
}
