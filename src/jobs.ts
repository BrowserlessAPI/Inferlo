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
import type { Audit } from "./audit.ts";
import type { Cache } from "./cache.ts";
import { createStorage, type Storage } from "./storage.ts";
import { cronTickId, isCron, type CronDef } from "./cron.ts";
import { checkTenantId, type DbHelpers } from "./db/table.ts";
import type { Adapter } from "./db/types.ts";
import { InferloError } from "./errors.ts";
import type { ErrorInfo } from "./logging.ts";
import { createEvents, isOn, type AppEvents, type EventTransport, type Events, type OnDef } from "./events.ts";
import type { AppDb } from "./route.ts";
import { createSocketHub, type SocketHub, type Sockets } from "./sockets.ts";
import { ValidationError, type AnySchema, type Infer, type InferInput } from "./schema.ts";
import type { JobTraceContext, JobTracing } from "./tracing.ts";

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
  /** Publish events: await events.publish(orderPaid, { orderId }) queues the jobs subscribed with on(event, job). */
  events: Events;
  /** The app cache, the same as ctx.cache in routes and app.cache. */
  cache: Cache;
  /** Files (createApp({ storage })), the same as ctx.storage in routes and app.storage. */
  storage: Storage;
  /** Send to WebSocket rooms of this process (the job's tenant's rooms with a tenant): await sockets.broadcast(room, data). */
  sockets: Sockets;
  /** Job id. */
  id: string;
  /** 1 on the first run, 2 on the first retry, and so on. */
  attempt: number;
  /**
   * The tenant the job works for (the tenant of the request or job that queued it, or enqueue's tenantId), or null.
   * ctx.db is scoped to it, and jobs and events queued from this job keep it.
   */
  tenantId: string | null;
  /**
   * Write an audit log entry (needs AuditLog in createApp({ models })). Jobs have no signed-in user: pass the
   * userId of the user who asked for the work, or leave it out for work the system does on its own.
   */
  audit: Audit;
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
  /**
   * The tenant the job works for: its ctx.db is scoped to it (tenant-scoped models). Default: the tenant of the
   * request or job that enqueues it, none from app.jobs. Pass null to queue it without a tenant.
   */
  tenantId?: string | null;
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
  /** With createApp({ tracing }): the trace (W3C traceparent and tracestate) of the request or job that enqueued it, which its runs continue. */
  trace?: JobTraceContext;
  /** The tenant the job works for (multi-tenancy): its ctx.db is scoped to it. */
  tenantId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Jobs {
  /** Validate the input and queue the job. Returns the queued record. */
  enqueue<J extends JobDef>(job: J, input: JobInput<J>, options?: EnqueueOptions): Promise<JobRecord>;
}

export interface JobQueueConfig {
  /**
   * Where queued jobs are kept. "memory" (default): in this process, for development and tests.
   * "database": in the inferlo_jobs table of the app's Postgres database, shared by every instance.
   * "redis": in the Redis of createApp({ redis }), shared by every instance.
   */
  store?: "memory" | "database" | "redis";
}

/** Where queued jobs are kept. */
export interface JobStore {
  /** Add a record. A record whose id is already stored is ignored (cron ticks use fixed ids). */
  add(record: JobRecord): Promise<void>;
  /** Mark up to limit pending jobs named in names with runAt <= now as running (attempts + 1) and return them, oldest first. */
  claim(now: Date, limit: number, names: readonly string[]): Promise<JobRecord[]>;
  update(id: string, patch: Partial<Pick<JobRecord, "status" | "runAt" | "lastError">>): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
  /** Record that a running job is still alive (database and Redis stores), so it is not picked up again as stuck. */
  touch?(id: string): Promise<void>;
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
  /** The registered crons: cron(schedule, job) values in createApp({ jobs }). */
  readonly crons: readonly CronDef[];
  /** Where queued jobs are kept (createApp({ jobQueue: { store } })). */
  readonly queue: "memory" | "database" | "redis";
  /** A queued job by id, or null. */
  get(id: string): Promise<JobRecord | null>;
  /** Run every job that is due now (or at options.now), one after another, including follow-ups they enqueue, then return. For tests and scripts. */
  runDue(options?: { now?: Date }): Promise<RunResult>;
  /**
   * Run due jobs in this process every pollMs (default 1000) until stop() is called. Also queues each cron's job at
   * every tick after the start, and with an events transport, the jobs of the events it receives.
   */
  start(options?: { pollMs?: number }): Worker;
}

/** Workers started with app.jobs.start() that have not been stopped, so app.close() can stop them. */
const workers = new WeakMap<AppJobs, Set<Worker>>();

/** Stop every worker started with jobs.start() and wait for their running jobs (used by app.close()). */
export async function stopWorkers(jobs: AppJobs): Promise<void> {
  await Promise.all([...(workers.get(jobs) ?? [])].map((w) => w.stop()));
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

/** Anything that contains jobs: a job, a cron, an event subscription (on), an array, or a module (import * as jobs from "./jobs.ts"). */
export type JobSource = JobDef | CronDef | OnDef | readonly JobSource[] | { readonly [name: string]: unknown };

/** The jobs and crons in createApp({ jobs }). A cron's job is registered with it. */
export function collectJobs(sources: readonly JobSource[] | undefined): JobDef[] {
  return collect(sources).jobs;
}

export function collectCrons(sources: readonly JobSource[] | undefined): CronDef[] {
  return collect(sources).crons;
}

/** The event subscriptions, on(event, job), in createApp({ jobs }). */
export function collectSubscriptions(sources: readonly JobSource[] | undefined): OnDef[] {
  return collect(sources).subscriptions;
}

function collect(sources: readonly JobSource[] | undefined): { jobs: JobDef[]; crons: CronDef[]; subscriptions: OnDef[] } {
  const out: JobDef[] = [];
  const crons: CronDef[] = [];
  const subscriptions: OnDef[] = [];
  const seen = new Set<unknown>();
  const visit = (source: unknown) => {
    if (!source || typeof source !== "object" || seen.has(source)) return;
    seen.add(source);
    if (isJob(source)) out.push(source);
    else if (isCron(source)) {
      crons.push(source);
      visit(source.job);
    } else if (isOn(source)) {
      subscriptions.push(source);
      visit(source.job);
    } else if (Array.isArray(source)) source.forEach(visit);
    else for (const value of Object.values(source)) if (isJob(value) || isCron(value) || isOn(value) || Array.isArray(value)) visit(value);
  };
  visit(sources);
  const names = new Map<string, JobDef>();
  for (const j of out) {
    if (names.has(j.name)) throw new InferloError("IL6009", `Two jobs are named "${j.name}".`, { fix: "Give each job a unique name." });
    names.set(j.name, j);
  }
  return { jobs: out, crons, subscriptions };
}

/** Jobs kept in this process. They are lost when it stops, so use it for development and tests. */
export function memoryJobStore(): JobStore {
  const records = new Map<string, JobRecord>();
  const copy = (r: JobRecord): JobRecord => ({ ...r, runAt: new Date(r.runAt), createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) });
  return {
    async add(record) {
      if (!records.has(record.id)) records.set(record.id, copy(record));
    },
    async claim(now, limit, names) {
      const due = [...records.values()]
        .filter((r) => r.status === "pending" && r.runAt.getTime() <= now.getTime() && names.includes(r.name))
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

/** A running job whose worker has not reported for this long is treated as stuck (its process stopped) and run again. */
export const STALE_AFTER_MS = 5 * 60_000;
/** How often a worker reports that a running job is still alive. */
export const HEARTBEAT_MS = 30_000;
export const STOPPED_MESSAGE = "The worker stopped while running this job (the process exited or lost its database connection).";

const JOB_COLUMNS = `"id", "name", "input", "status", "attempts", "max_attempts", "run_at", "last_error", "created_at", "updated_at", "traceparent", "tracestate", "tenant_id"`;

function fromRow(row: Record<string, unknown>): JobRecord {
  const record: JobRecord = {
    id: String(row.id),
    name: String(row.name),
    input: typeof row.input === "string" ? (JSON.parse(row.input) as unknown) : row.input,
    status: row.status as JobStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAt: new Date(row.run_at as string),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
  if (row.last_error !== null && row.last_error !== undefined) record.lastError = String(row.last_error);
  if (typeof row.traceparent === "string") {
    record.trace = { traceparent: row.traceparent };
    if (typeof row.tracestate === "string") record.trace.tracestate = row.tracestate;
  }
  if (typeof row.tenant_id === "string") record.tenantId = row.tenant_id;
  return record;
}

/**
 * Jobs in the inferlo_jobs table (created on first use), shared by every instance. Due jobs are
 * claimed with FOR UPDATE SKIP LOCKED, so each one runs in one place. A running job whose worker
 * stopped reporting (see STALE_AFTER_MS) is claimed again, or marked failed if it has no attempts left.
 */
export function databaseJobStore(adapter: Adapter, options: { staleAfterMs?: number } = {}): JobStore {
  const sql = adapter.sql?.bind(adapter);
  if (!sql) {
    throw new InferloError("IL6012", `jobQueue store "database" needs a Postgres database, but the app uses the ${adapter.dialect} adapter.`, {
      fix: 'Use postgres() from "@browserlessapi/inferlo/postgres" for createApp({ db }), or jobQueue: { store: "memory" }.',
    });
  }
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  let ready: Promise<unknown> | undefined;
  const create = async () => {
    try {
      await sql(
        `CREATE TABLE IF NOT EXISTS "inferlo_jobs" (
          "id" uuid PRIMARY KEY, "name" text NOT NULL, "input" jsonb NOT NULL, "status" text NOT NULL,
          "attempts" integer NOT NULL, "max_attempts" integer NOT NULL, "run_at" timestamptz NOT NULL,
          "last_error" text, "created_at" timestamptz NOT NULL, "updated_at" timestamptz NOT NULL,
          "traceparent" text, "tracestate" text, "tenant_id" text)`,
      );
      // Tables created by earlier versions get the trace (Inferlo 0.6) and tenant (0.7) columns.
      await sql('ALTER TABLE "inferlo_jobs" ADD COLUMN IF NOT EXISTS "traceparent" text, ADD COLUMN IF NOT EXISTS "tracestate" text, ADD COLUMN IF NOT EXISTS "tenant_id" text');
      await sql('CREATE INDEX IF NOT EXISTS "inferlo_jobs_due_idx" ON "inferlo_jobs" ("status", "run_at")');
    } catch {
      // Two instances creating the table at the same moment: the other one won.
      await sql('SELECT 1 FROM "inferlo_jobs" LIMIT 1');
    }
  };
  const table = async () => {
    ready ??= create().catch((error) => {
      ready = undefined;
      throw error;
    });
    await ready;
  };
  return {
    async add(r) {
      await table();
      await sql(`INSERT INTO "inferlo_jobs" (${JOB_COLUMNS}) VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT ("id") DO NOTHING`, [
        r.id, r.name, JSON.stringify(r.input), r.status, r.attempts, r.maxAttempts, r.runAt, r.lastError ?? null, r.createdAt, r.updatedAt, r.trace?.traceparent ?? null, r.trace?.tracestate ?? null, r.tenantId ?? null,
      ]);
    },
    async claim(now, limit, names) {
      await table();
      if (!names.length) return [];
      const stale = `"status" = 'running' AND "updated_at" < now() - $1 * interval '1 millisecond'`;
      // Stuck jobs without attempts left are failed, not run again.
      await sql(`UPDATE "inferlo_jobs" SET "status" = 'failed', "last_error" = $2, "updated_at" = now() WHERE ${stale} AND "attempts" >= "max_attempts" AND "name" = ANY($3)`, [
        staleAfterMs, STOPPED_MESSAGE, names,
      ]);
      const rows = await sql(
        `WITH due AS (
           SELECT "id" FROM "inferlo_jobs"
           WHERE "name" = ANY($3) AND (("status" = 'pending' AND "run_at" <= $4) OR (${stale} AND "attempts" < "max_attempts"))
           ORDER BY "run_at", "created_at" LIMIT $5 FOR UPDATE SKIP LOCKED)
         UPDATE "inferlo_jobs" j SET "status" = 'running', "attempts" = j."attempts" + 1, "updated_at" = now(),
           "last_error" = CASE WHEN j."status" = 'running' THEN $2 ELSE j."last_error" END
         FROM due WHERE j."id" = due."id"
         RETURNING j.*`,
        [staleAfterMs, STOPPED_MESSAGE, names, now, limit],
      );
      return rows
        .map(fromRow)
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
    },
    async update(id, patch) {
      await table();
      const sets = ['"updated_at" = now()'];
      const params: unknown[] = [id];
      if (patch.status !== undefined) sets.push(`"status" = $${params.push(patch.status)}`);
      if (patch.runAt !== undefined) sets.push(`"run_at" = $${params.push(patch.runAt)}`);
      if (patch.lastError !== undefined) sets.push(`"last_error" = $${params.push(patch.lastError)}`);
      await sql(`UPDATE "inferlo_jobs" SET ${sets.join(", ")} WHERE "id" = $1`, params);
    },
    async get(id) {
      await table();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
      const rows = await sql(`SELECT ${JOB_COLUMNS} FROM "inferlo_jobs" WHERE "id" = $1`, [id]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async touch(id) {
      await table();
      await sql(`UPDATE "inferlo_jobs" SET "updated_at" = now() WHERE "id" = $1 AND "status" = 'running'`, [id]);
    },
  };
}

/**
 * Pick the job store for createApp({ jobQueue }). Raises IL6011 for an unknown store, IL6012 for "database" without
 * Postgres. "redis" uses the redis option, a function that returns the Redis store (or throws IL6031 without a client).
 */
/** Rooms for createJobs runtimes without WebSockets: broadcasts reach no one. */
const noSockets = createSocketHub();
const noStorage = createStorage(undefined);

export function jobStoreFor(config: JobQueueConfig | undefined, adapter: Adapter, redis?: () => JobStore): JobStore {
  const store = config?.store ?? "memory";
  if (store === "memory") return memoryJobStore();
  if (store === "database") return databaseJobStore(adapter);
  if (store === "redis" && redis) return redis();
  throw new InferloError("IL6011", `Invalid jobQueue store "${String(store)}".`, { fix: 'Use createApp({ jobQueue: { store: "memory" } }) (the default), { store: "database" } or { store: "redis" } with createApp({ redis }).' });
}

export interface JobRuntime {
  db: AppDb;
  ai: AI;
  cache: Cache;
  /** Files (app.storage). Default: none (ctx.storage throws IL6037). */
  storage?: Storage;
  /** WebSocket rooms (app.sockets). */
  sockets?: SocketHub;
  /** Builds ctx.audit for one run. */
  audit(job: { name: string; id: string; tenantId: string | null }): Audit;
  store: JobStore;
  /** Name of the store, shown as app.jobs.queue. Default "memory". */
  queue?: "memory" | "database" | "redis";
  /** How often a running job is reported alive to stores that support it. Default HEARTBEAT_MS. */
  heartbeatMs?: number;
  logger: { info(message: string, data?: unknown): void; error(message: string, data?: unknown): void };
  /** createApp({ onError }): told about each failed attempt. */
  onError?(error: unknown, info: ErrorInfo): void;
  /** Called after each attempt with its outcome and duration (metrics). */
  onRun?(name: string, outcome: keyof RunResult, durationMs: number): void;
  /** With createApp({ tracing }): a span per attempt that continues the trace the job was enqueued in. */
  tracing?: JobTracing;
  /** With createApp({ events: { transport } }): carries published events between services. */
  eventTransport?: EventTransport;
}

/** app.jobs plus what the framework tests reach directly. */
export interface InternalJobs extends AppJobs {
  /** Queue the job of each cron's latest tick in (from, to]. */
  queueCrons(from: Date, to: Date): Promise<void>;
  /** app.events: publishing queues the jobs subscribed with on(event, job). */
  readonly events: AppEvents;
}

export function createJobs(list: readonly JobDef[], runtime: JobRuntime, crons: readonly CronDef[] = [], subscriptions: readonly OnDef[] = []): InternalJobs {
  const byName = new Map(list.map((j) => [j.name, j]));
  const names = list.map((j) => j.name);
  const running = new Set<Worker>();

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

  const record = (def: JobDef, input: unknown, runAt: Date | undefined, id: string): JobRecord => {
    // Stored as JSON, so it survives a restart with a database store; parsed again when it runs.
    const stored = JSON.parse(JSON.stringify(parse(def, input) ?? null)) as unknown;
    const now = new Date();
    return {
      id,
      name: def.name,
      input: stored,
      status: "pending",
      attempts: 0,
      maxAttempts: 1 + (def.options.retries ?? 3),
      runAt: runAt ?? now,
      createdAt: now,
      updatedAt: now,
    };
  };

  /** Queue the job of every cron tick in (from, to]. Only the latest tick of each cron is queued, so a pause does not cause a burst. */
  const queueCrons = async (from: Date, to: Date) => {
    for (const c of crons) {
      let tick = c.next(from);
      if (tick.getTime() > to.getTime()) continue;
      for (let later = c.next(tick); later.getTime() <= to.getTime(); later = c.next(later)) tick = later;
      await runtime.store.add(record(c.job, {}, tick, await cronTickId(c, tick)));
    }
  };

  const events = createEvents(subscriptions, {
    async enqueue(def, input, id, from, tenantId) {
      const queued = record(registered(def), input, undefined, id);
      const trace = from ?? runtime.tracing?.capture();
      if (runtime.tracing && trace?.traceparent) queued.trace = trace;
      if (tenantId) queued.tenantId = tenantId;
      await runtime.store.add(queued);
      return id;
    },
    transport: runtime.eventTransport,
    capture: runtime.tracing ? () => runtime.tracing!.capture() : undefined,
    logger: runtime.logger,
  });

  const jobs: InternalJobs = {
    list,
    crons,
    events,
    queueCrons,
    queue: runtime.queue ?? "memory",
    async enqueue(j, input, options = {}) {
      const def = registered(j);
      if (options.runAt !== undefined && (!(options.runAt instanceof Date) || Number.isNaN(options.runAt.getTime()))) {
        throw new InferloError("IL6009", `runAt for job "${def.name}" must be a valid Date.`, { fix: "Pass runAt: new Date(Date.now() + 60_000) or leave it out to run now." });
      }
      const tenantId = options.tenantId === undefined || options.tenantId === null ? undefined : checkTenantId(options.tenantId);
      const queued = record(def, input, options.runAt, crypto.randomUUID());
      const trace = runtime.tracing?.capture();
      if (trace?.traceparent) queued.trace = trace;
      if (tenantId) queued.tenantId = tenantId;
      await runtime.store.add(queued);
      return queued;
    },

    get: (id) => runtime.store.get(id),

    async runDue(options = {}) {
      const result: RunResult = { done: 0, retried: 0, failed: 0 };
      while (true) {
        // Without options.now, jobs enqueued by the jobs that run (follow-ups) run in the same call.
        const now = options.now ?? new Date();
        const [record] = await runtime.store.claim(now, 1, names);
        if (!record) return result;
        result[await run(record, now)]++;
      }
    },

    start(options = {}) {
      const pollMs = options.pollMs ?? 1000;
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      let cronFrom = new Date();
      const loop = (async () => {
        while (!stopped) {
          try {
            if (crons.length) {
              const now = new Date();
              await queueCrons(cronFrom, now);
              cronFrom = now;
            }
            // Events from other services (createApp({ events: { transport } })) queue their jobs first.
            if (events.transport) await events.receive().catch((error: unknown) => runtime.logger.error("event receive error", error));
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
      const worker: Worker = {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
          wake?.();
          await loop;
          running.delete(worker);
        },
      };
      running.add(worker);
      return worker;
    },
  };
  workers.set(jobs, running);

  async function run(record: JobRecord, now: Date): Promise<keyof RunResult> {
    const started = performance.now();
    const outcome = runtime.tracing ? await runtime.tracing.run(record, (fail) => attempt(record, now, fail)) : await attempt(record, now);
    runtime.onRun?.(record.name, outcome, performance.now() - started);
    return outcome;
  }

  async function attempt(record: JobRecord, now: Date, fail?: (error: unknown) => void): Promise<keyof RunResult> {
    const def = byName.get(record.name);
    const touch = runtime.store.touch?.bind(runtime.store);
    const heartbeat = touch ? setInterval(() => void touch(record.id).catch(() => {}), runtime.heartbeatMs ?? HEARTBEAT_MS) : undefined;
    try {
      if (!def) throw new InferloError("IL6010", `"${record.name}" is not a registered job.`, { fix: "Add the job to createApp({ jobs: [...] }) in the process that runs jobs." });
      const tenantId = record.tenantId ?? null;
      const scoped = tenantId ? withTenant({ jobs, events }, tenantId) : { jobs, events };
      const db = tenantId ? ((runtime.db as unknown as DbHelpers).$tenant(tenantId) as unknown as AppDb) : runtime.db;
      await def.handler({ input: parse(def, record.input), db, ai: runtime.ai, jobs: scoped.jobs, events: scoped.events, cache: runtime.cache, storage: runtime.storage ?? noStorage, sockets: (runtime.sockets ?? noSockets).forTenant(tenantId), id: record.id, attempt: record.attempts, tenantId, audit: runtime.audit({ name: record.name, id: record.id, tenantId }) });
      await runtime.store.update(record.id, { status: "done" });
      return "done";
    } catch (error) {
      fail?.(error);
      const message = error instanceof Error ? error.message : String(error);
      const report = () => {
        if (!runtime.onError) return;
        const traceId = record.trace?.traceparent?.split("-")[1];
        runtime.onError(error, { source: "job", job: record.name, jobId: record.id, attempt: record.attempts, maxAttempts: record.maxAttempts, final: record.attempts >= record.maxAttempts, ...(record.tenantId ? { tenantId: record.tenantId } : {}), ...(traceId ? { traceId } : {}) });
      };
      if (record.attempts < record.maxAttempts) {
        await runtime.store.update(record.id, { status: "pending", lastError: message, runAt: new Date(now.getTime() + retryDelayMs(record.attempts)) });
        runtime.logger.error(`job "${record.name}" failed (attempt ${record.attempts} of ${record.maxAttempts}), will retry`, { id: record.id, error: message });
        report();
        return "retried";
      }
      await runtime.store.update(record.id, { status: "failed", lastError: message });
      runtime.logger.error(`job "${record.name}" failed after ${record.attempts} attempt(s)`, { id: record.id, error: message });
      report();
      return "failed";
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  return jobs;
}

/**
 * ctx.jobs and ctx.events for one tenant: jobs and events queued through them carry the tenant unless the call
 * names another (tenantId) or none (null). Internal: used for requests and jobs with a tenant.
 */
export function withTenant(base: { jobs: Jobs; events: Events }, tenantId: string): { jobs: Jobs; events: Events } {
  return {
    jobs: { enqueue: (job, input, options = {}) => base.jobs.enqueue(job, input, { ...options, tenantId: options.tenantId === undefined ? tenantId : options.tenantId }) },
    events: { publish: (event, payload, options = {}) => base.events.publish(event, payload, { ...options, tenantId: options.tenantId === undefined ? tenantId : options.tenantId }) },
  };
}
