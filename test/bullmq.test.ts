// Inferlo jobs on BullMQ (@browserlessapi/inferlo/bullmq), against a real Redis when INFERLO_TEST_REDIS_URL is set
// (CI runs the newest BullMQ 5 on the oldest supported Redis and the latest BullMQ on the latest Redis).
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createApp, InferloError, job, t } from "../src/index.ts";
import { bullmqJobStore, type BullMQJob, type BullMQQueue, type BullMQWorker } from "../src/bullmq.ts";
import { STOPPED_MESSAGE, type InternalJobs } from "../src/jobs.ts";
import { cron } from "../src/cron.ts";

const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info() {}, error() {} };
const run = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("bullmqJobStore() arguments", () => {
  const queue = { name: "inferlo", add: async () => {}, getJob: async () => null } as BullMQQueue;
  const worker = { name: "inferlo", opts: { autorun: false }, getNextJob: async () => undefined, startStalledCheckTimer: async () => {} } as BullMQWorker;

  test("checks the queue and the worker (IL6057)", () => {
    assert.throws(() => bullmqJobStore(undefined as never, worker), isCode("IL6057"));
    assert.throws(() => bullmqJobStore({ name: "inferlo" } as never, worker), isCode("IL6057"));
    assert.throws(() => bullmqJobStore(queue, undefined as never), isCode("IL6057"));
    assert.throws(() => bullmqJobStore(queue, { ...worker, getNextJob: undefined } as never), isCode("IL6057"));
    assert.throws(() => bullmqJobStore(queue, { ...worker, name: "emails" }), (e: unknown) => isCode("IL6057")(e) && /"emails"/.test((e as Error).message));
    assert.throws(() => bullmqJobStore(queue, { ...worker, opts: {} }), (e: unknown) => isCode("IL6057")(e) && /autorun: false/.test((e as Error).message));
    assert.throws(() => bullmqJobStore(queue, { ...worker, opts: { autorun: true } }), isCode("IL6057"));
  });

  test("app.jobs.queue and describe show bullmq", () => {
    const app = createApp({ jobQueue: { store: bullmqJobStore(queue, worker) }, logger: quiet });
    assert.equal(app.jobs.queue, "bullmq");
    assert.equal(app.describe().jobQueue, "bullmq");
  });
});

// A BullMQ Queue, Worker and connection, typed with what the test uses (bullmq and ioredis are dev dependencies).
type Queue = Omit<BullMQQueue, "getJob"> & { close(): Promise<void>; obliterate(options: { force: boolean }): Promise<void>; getJob(id: string): Promise<(BullMQJob & { promote(): Promise<void> }) | undefined> };
type Worker = BullMQWorker & { close(): Promise<void> };
type Bull = { Queue: new (name: string, options: object) => Queue; Worker: new (name: string, processor: null, options: object) => Worker };
const bull = REDIS_URL ? ((await import("bullmq" as string)) as Bull) : undefined;
const IORedis = REDIS_URL ? ((await import("ioredis" as string)) as { default: new (url: string, options: object) => { quit(): Promise<unknown> } }).default : undefined;

// describe.skip, because Bun 1.3.0 ignores { skip } on describe.
(REDIS_URL ? describe : describe.skip)("BullMQ job store", () => {
  const connection = REDIS_URL ? new IORedis!(REDIS_URL, { maxRetriesPerRequest: null }) : undefined;
  const queues: Queue[] = [];
  const workers: Worker[] = [];
  const open = (name: string, workerOptions: object = {}) => {
    const queue = new bull!.Queue(name, { connection });
    const worker = new bull!.Worker(name, null, { connection, autorun: false, ...workerOptions });
    if (!queues.includes(queue)) queues.push(queue);
    workers.push(worker);
    return { queue, worker };
  };
  after(async () => {
    for (const w of workers) await w.close();
    for (const q of queues) await q.obliterate({ force: true }).catch(() => {});
    for (const q of queues) await q.close();
    await connection?.quit();
  });

  const ran: string[] = [];
  const record = job("record", { input: t.object({ n: t.int(), at: t.date().optional() }), retries: 1 }).handle(async ({ input, attempt }) => {
    ran.push(`${input.n}:${attempt}`);
    await sleep(5);
    if (input.n < 0) throw new Error(`negative ${input.n}`);
  });
  const name = `${run}-jobs`;
  const makeApp = () => {
    const { queue, worker } = open(name);
    return createApp({ jobs: [record], jobQueue: { store: bullmqJobStore(queue, worker) }, logger: quiet });
  };

  test("jobs are BullMQ jobs, survive a new app instance and finish as completed", async () => {
    const first = makeApp();
    const queued = await first.jobs.enqueue(record, { n: 1, at: new Date("2030-01-01T00:00:00Z") }, { tenantId: "acme" });
    const second = makeApp();
    const stored = await second.jobs.get(queued.id);
    assert.equal(stored?.status, "pending");
    assert.deepEqual(stored?.input, { n: 1, at: "2030-01-01T00:00:00.000Z" });
    assert.equal(stored?.maxAttempts, 2);
    assert.equal(stored?.attempts, 0);
    assert.equal(stored?.tenantId, "acme");
    assert.equal(stored?.runAt.getTime(), queued.runAt.getTime());
    assert.equal(stored?.createdAt.getTime(), queued.createdAt.getTime());
    const bullJob = await queues[0]!.getJob(queued.id);
    assert.equal(bullJob?.name, "record", "the BullMQ job is named like the Inferlo job");
    ran.length = 0;
    assert.deepEqual(await second.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    assert.deepEqual(ran, ["1:1"]);
    const done = await first.jobs.get(queued.id);
    assert.equal(done?.status, "done");
    assert.equal(done?.attempts, 1);
    assert.equal(await (await queues[0]!.getJob(queued.id))?.getState(), "completed");
    assert.equal(await first.jobs.get("not-a-job"), null);
  });

  test("jobs due later wait in BullMQ's delayed set", async () => {
    const app = makeApp();
    const later = await app.jobs.enqueue(record, { n: 21 }, { runAt: new Date(Date.now() + 400) });
    await app.jobs.enqueue(record, { n: 20 });
    ran.length = 0;
    assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    assert.deepEqual(ran, ["20:1"]);
    assert.equal((await app.jobs.get(later.id))?.status, "pending");
    assert.equal(await (await queues[0]!.getJob(later.id))?.getState(), "delayed");
    await sleep(500);
    assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    assert.deepEqual(ran, ["20:1", "21:1"]);
  });

  test("retries use Inferlo's backoff, and the last failure fails the BullMQ job", async () => {
    const app = makeApp();
    const queued = await app.jobs.enqueue(record, { n: -1 });
    assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 1, failed: 0 });
    const retrying = (await app.jobs.get(queued.id))!;
    assert.equal(retrying.status, "pending");
    assert.equal(retrying.lastError, "negative -1");
    assert.equal(retrying.attempts, 1);
    assert.ok(retrying.runAt.getTime() > Date.now() + 5_000);
    const bullJob = (await queues[0]!.getJob(queued.id))!;
    assert.equal(await bullJob.getState(), "delayed");
    assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 0, failed: 0 }, "not due yet");
    await bullJob.promote();
    assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 0, failed: 1 });
    const failed = (await app.jobs.get(queued.id))!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 2);
    assert.equal(failed.lastError, "negative -1");
    const finished = (await queues[0]!.getJob(queued.id))!;
    assert.equal(await finished.getState(), "failed");
    assert.equal(finished.failedReason, "negative -1");
  });

  test("instances share the queue and each job runs exactly once", async () => {
    const apps = [makeApp(), makeApp(), makeApp()];
    ran.length = 0;
    for (let n = 100; n < 130; n++) await apps[n % 3]!.jobs.enqueue(record, { n });
    const results = await Promise.all(apps.map((a) => a.jobs.runDue()));
    assert.equal(results.reduce((sum, r) => sum + r.done, 0), 30);
    assert.deepEqual([...ran].sort(), Array.from({ length: 30 }, (_, i) => `${100 + i}:1`).sort());
  });

  test("a job whose worker stopped is run again; without attempts left it is failed", async () => {
    const queueName = `${run}-stale`;
    const options = { lockDuration: 300, stalledInterval: 200, maxStalledCount: 5 };
    const { queue } = open(queueName, options);
    const crashed = open(queueName, options).worker;
    const store = bullmqJobStore(queue, open(queueName, options).worker);
    const now = new Date();
    const add = (id: string, maxAttempts: number) => store.add({ id, name: "stale", input: {}, status: "pending", attempts: 0, maxAttempts, runAt: now, createdAt: now, updatedAt: now });
    const retried = crypto.randomUUID();
    const exhausted = crypto.randomUUID();
    await add(retried, 3);
    await add(exhausted, 1);
    // Another process takes both jobs and stops without finishing them (no lock renewal).
    assert.ok(await crashed.getNextJob("crashed-1", { block: false }));
    assert.ok(await crashed.getNextJob("crashed-2", { block: false }));
    assert.deepEqual(await store.claim(new Date(), 5, ["stale"]), [], "running jobs are not taken while their lock holds");
    let again: Awaited<ReturnType<typeof store.claim>> = [];
    for (let i = 0; i < 40 && !again.length; i++) {
      await sleep(100);
      again = await store.claim(new Date(), 5, ["stale"]);
    }
    assert.deepEqual(again.map((r) => [r.id, r.attempts, r.status, r.lastError]), [[retried, 2, "running", STOPPED_MESSAGE]]);
    await store.update(retried, { status: "done" });
    const failed = (await store.get(exhausted))!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, STOPPED_MESSAGE);
  });

  test("a running job keeps its lock while it runs", async () => {
    const queueName = `${run}-lock`;
    const options = { lockDuration: 300, stalledInterval: 150 };
    const { queue, worker } = open(queueName, options);
    const other = open(queueName, options).worker;
    const store = bullmqJobStore(queue, worker);
    const now = new Date();
    const id = crypto.randomUUID();
    await store.add({ id, name: "slow", input: {}, status: "pending", attempts: 0, maxAttempts: 3, runAt: now, createdAt: now, updatedAt: now });
    assert.equal((await store.claim(new Date(), 5, ["slow"])).length, 1);
    await other.startStalledCheckTimer();
    await sleep(1200);
    assert.equal((await store.get(id))?.status, "running");
    assert.equal(await other.getNextJob("other", { block: false }), undefined);
    await store.update(id, { status: "done" });
    assert.equal((await store.get(id))?.status, "done");
    assert.equal((await store.get(id))?.attempts, 1);
  });

  test("a record whose id is already queued is ignored, and the trace is kept", async () => {
    const { queue, worker } = open(`${run}-dup`);
    const store = bullmqJobStore(queue, worker);
    const now = new Date();
    const id = crypto.randomUUID();
    const trace = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "vendor=1" };
    await store.add({ id, name: "dup", input: { a: 1 }, status: "pending", attempts: 0, maxAttempts: 1, runAt: now, createdAt: now, updatedAt: now, trace });
    await store.add({ id, name: "dup", input: { a: 2 }, status: "pending", attempts: 0, maxAttempts: 1, runAt: now, createdAt: now, updatedAt: now });
    const stored = (await store.get(id))!;
    assert.deepEqual(stored.input, { a: 1 });
    assert.deepEqual(stored.trace, trace);
    const claimed = await store.claim(new Date(), 5, ["dup"]);
    assert.equal(claimed.length, 1, "queued once");
    assert.deepEqual(claimed[0]!.trace, trace);
    await store.update(id, { status: "done" });
  });

  test("a job that Inferlo did not queue is failed with a message", async () => {
    const { queue, worker } = open(`${run}-foreign`);
    const store = bullmqJobStore(queue, worker);
    await queue.add("someone-else", { hello: "world" }, { jobId: "foreign-1" });
    assert.deepEqual(await store.claim(new Date(), 5, ["x"]), []);
    const foreign = (await queue.getJob("foreign-1"))!;
    assert.equal(await foreign.getState(), "failed");
    assert.match(foreign.failedReason ?? "", /own BullMQ queue/);
    assert.equal(await store.get("foreign-1"), null);
  });

  test("cron ticks are queued once across instances", async () => {
    const seen: string[] = [];
    const shared = job("cron-job", { input: t.object({}) }).handle(({ id }) => void seen.push(id));
    const schedule = cron("*/5 * * * *", shared);
    const queueName = `${run}-cron`;
    const apps = [0, 1, 2].map(() => {
      const { queue, worker } = open(queueName);
      return createApp({ jobs: [schedule], jobQueue: { store: bullmqJobStore(queue, worker) }, logger: quiet });
    });
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 60_000);
    await Promise.all(apps.map((a) => (a.jobs as InternalJobs).queueCrons(from, to)));
    const results = await Promise.all(apps.map((a) => a.jobs.runDue()));
    assert.equal(results.reduce((n, r) => n + r.done, 0), 1);
    assert.equal(seen.length, 1);
  });

  test("app.jobs.start() runs queued jobs and app.close() stops it", async () => {
    const app = makeApp();
    ran.length = 0;
    app.jobs.start({ pollMs: 20 });
    const queued = await app.jobs.enqueue(record, { n: 42 });
    for (let i = 0; i < 100 && (await app.jobs.get(queued.id))?.status !== "done"; i++) await sleep(20);
    await app.close();
    assert.equal((await app.jobs.get(queued.id))?.status, "done");
    assert.deepEqual(ran, ["42:1"]);
  });
});
