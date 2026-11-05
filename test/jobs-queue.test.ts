import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createApp, InferloError, job, memory, t, type Adapter, type JobQueueConfig } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { databaseJobStore, STOPPED_MESSAGE, type InternalJobs } from "../src/jobs.ts";
import { redisJobStore } from "../src/redis-jobs.ts";
import { cron } from "../src/cron.ts";
import { createClient } from "redis";
import type { RedisClient } from "../src/redis.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info: () => {}, error: () => {} };
// Unique job names per run, so runs against the same database do not see each other's jobs.
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describe("job queue config", () => {
  test("store database needs Postgres (IL6012), unknown stores raise IL6011", () => {
    assert.throws(() => createApp({ jobQueue: { store: "database" } }), (e: unknown) => e instanceof InferloError && e.code === "IL6012" && /memory adapter/.test(e.message));
    assert.throws(() => createApp({ jobQueue: { store: "kafka" } as unknown as JobQueueConfig }), (e: unknown) => e instanceof InferloError && e.code === "IL6011" && /redis/.test(e.fix ?? ""));
    assert.throws(() => createApp({ jobQueue: { store: "redis" } }), (e: unknown) => e instanceof InferloError && e.code === "IL6031" && /jobQueue store "redis"/.test(e.message));
    const redis: RedisClient = { sendCommand: async () => null };
    const app = createApp({ redis, jobQueue: { store: "redis" } });
    assert.equal(app.jobs.queue, "redis");
    assert.equal(app.describe().jobQueue, "redis");
    assert.doesNotThrow(() => createApp({ jobQueue: { store: "memory" } }));
  });

  test("a worker only claims jobs it has registered", async () => {
    const db = memory();
    const known = job(`known-${suffix}`, { input: t.object({}) }).handle(() => {});
    const other = job(`other-${suffix}`, { input: t.object({}) }).handle(() => {});
    const app = createApp({ db, jobs: [known, other], logger: quiet });
    await app.jobs.enqueue(other, {});
    await app.jobs.enqueue(known, {});
    assert.deepEqual(await app.jobs.runDue(), { done: 2, retried: 0, failed: 0 });
  });
});

if (PG_URL) {
  describe("job queue (database store)", () => {
    const adapters: Adapter[] = [];
    const pg = () => {
      const a = postgres({ url: PG_URL });
      adapters.push(a);
      return a;
    };
    after(async () => {
      for (const a of adapters) await a.close?.();
    });

    const ran: string[] = [];
    const record = job(`record-${suffix}`, { input: t.object({ n: t.int(), at: t.date().optional() }), retries: 1 }).handle(async ({ input, attempt }) => {
      ran.push(`${input.n}:${attempt}`);
      await new Promise((r) => setTimeout(r, 5));
      if (input.n < 0) throw new Error(`negative ${input.n}`);
    });
    const makeApp = (db: Adapter) => createApp({ db, jobs: [record], jobQueue: { store: "database" }, logger: quiet });

    test("jobs are stored in inferlo_jobs and survive a new app instance (restart)", async () => {
      const first = makeApp(pg());
      const queued = await first.jobs.enqueue(record, { n: 1, at: new Date("2030-01-01T00:00:00Z") });
      const second = makeApp(pg());
      const stored = await second.jobs.get(queued.id);
      assert.equal(stored?.status, "pending");
      assert.deepEqual(stored?.input, { n: 1, at: "2030-01-01T00:00:00.000Z" });
      assert.equal(stored?.maxAttempts, 2);
      assert.equal(stored?.runAt.getTime(), queued.runAt.getTime());
      ran.length = 0;
      assert.deepEqual(await second.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
      assert.deepEqual(ran, ["1:1"]);
      const done = await first.jobs.get(queued.id);
      assert.equal(done?.status, "done");
      assert.equal(done?.attempts, 1);
      assert.equal(await first.jobs.get("not-a-uuid"), null);
    });

    test("retries and failure are recorded in the table", async () => {
      const app = makeApp(pg());
      const queued = await app.jobs.enqueue(record, { n: -1 });
      assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 1, failed: 0 });
      const retrying = (await app.jobs.get(queued.id))!;
      assert.equal(retrying.status, "pending");
      assert.equal(retrying.lastError, "negative -1");
      assert.ok(retrying.runAt.getTime() > Date.now() + 5_000);
      assert.deepEqual(await app.jobs.runDue({ now: new Date(Date.now() + 11_000) }), { done: 0, retried: 0, failed: 1 });
      assert.equal((await app.jobs.get(queued.id))!.status, "failed");
    });

    test("instances share the queue and each job runs exactly once (FOR UPDATE SKIP LOCKED)", async () => {
      const apps = [makeApp(pg()), makeApp(pg()), makeApp(pg())];
      ran.length = 0;
      for (let n = 100; n < 120; n++) await apps[n % 3]!.jobs.enqueue(record, { n });
      const results = await Promise.all(apps.map((a) => a.jobs.runDue()));
      assert.equal(results.reduce((sum, r) => sum + r.done, 0), 20);
      assert.deepEqual([...ran].sort(), Array.from({ length: 20 }, (_, i) => `${100 + i}:1`).sort());
    });

    test("a job left running by a stopped worker is picked up again; without attempts left it is failed", async () => {
      const db = pg();
      const app = makeApp(db);
      const crashed = await app.jobs.enqueue(record, { n: 7 });
      const exhausted = await app.jobs.enqueue(record, { n: 8 });
      const sql = db.sql!.bind(db);
      await sql(`UPDATE "inferlo_jobs" SET "status" = 'running', "attempts" = 1, "updated_at" = now() - interval '10 minutes' WHERE "id" = $1`, [crashed.id]);
      await sql(`UPDATE "inferlo_jobs" SET "status" = 'running', "attempts" = 2, "updated_at" = now() - interval '10 minutes' WHERE "id" = $1`, [exhausted.id]);
      ran.length = 0;
      assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
      assert.deepEqual(ran, ["7:2"]);
      const again = (await app.jobs.get(crashed.id))!;
      assert.equal(again.status, "done");
      assert.equal(again.attempts, 2);
      assert.equal(again.lastError, STOPPED_MESSAGE);
      const failed = (await app.jobs.get(exhausted.id))!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.lastError, STOPPED_MESSAGE);
    });

    test("a running job that still reports is not picked up again", async () => {
      const db = pg();
      // Wide margins: on a busy CI runner the time between a report and the next claim can be over 200 ms.
      const store = databaseJobStore(db, { staleAfterMs: 1000 });
      const name = `slow-${suffix}`;
      const now = new Date();
      const id = crypto.randomUUID();
      await store.add({ id, name, input: {}, status: "pending", attempts: 0, maxAttempts: 3, runAt: now, createdAt: now, updatedAt: now });
      assert.equal((await store.claim(new Date(), 5, [name])).length, 1);
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 250));
        await store.touch!(id);
        assert.equal((await store.claim(new Date(), 5, [name])).length, 0);
      }
      await new Promise((r) => setTimeout(r, 1300));
      const reclaimed = await store.claim(new Date(), 5, [name]);
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0]!.attempts, 2);
    });
  });
}

if (REDIS_URL) {
  describe("job queue (redis store)", () => {
    const connected = createClient({ url: REDIS_URL }).connect();
    const redis: RedisClient = { sendCommand: async (args) => (await connected).sendCommand(args) };
    after(async () => {
      await (await connected).close();
    });

    const ran: string[] = [];
    const record = job(`rrecord-${suffix}`, { input: t.object({ n: t.int(), at: t.date().optional() }), retries: 1 }).handle(async ({ input, attempt }) => {
      ran.push(`${input.n}:${attempt}`);
      await new Promise((r) => setTimeout(r, 5));
      if (input.n < 0) throw new Error(`negative ${input.n}`);
    });
    // Each app name has its own keys, so every run of this file starts from an empty queue.
    const name = `jobs-${suffix}`;
    const makeApp = () => createApp({ name, redis, jobs: [record], jobQueue: { store: "redis" }, logger: quiet });

    test("jobs are stored in Redis and survive a new app instance (restart)", async () => {
      const first = makeApp();
      const queued = await first.jobs.enqueue(record, { n: 1, at: new Date("2030-01-01T00:00:00Z") });
      const second = makeApp();
      const stored = await second.jobs.get(queued.id);
      assert.equal(stored?.status, "pending");
      assert.deepEqual(stored?.input, { n: 1, at: "2030-01-01T00:00:00.000Z" });
      assert.equal(stored?.maxAttempts, 2);
      assert.equal(stored?.attempts, 0);
      assert.equal(stored?.runAt.getTime(), queued.runAt.getTime());
      assert.equal(stored?.createdAt.getTime(), queued.createdAt.getTime());
      ran.length = 0;
      assert.deepEqual(await second.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
      assert.deepEqual(ran, ["1:1"]);
      const done = await first.jobs.get(queued.id);
      assert.equal(done?.status, "done");
      assert.equal(done?.attempts, 1);
      assert.equal(await first.jobs.get("not-a-job"), null);
      // Finished jobs are kept for a while, then Redis removes them.
      const ttl = Number(await redis.sendCommand(["PTTL", `inferlo:${name}:jobs:job:${queued.id}`]));
      assert.ok(ttl > 6 * 24 * 3600_000 && ttl <= 7 * 24 * 3600_000, String(ttl));
    });

    test("jobs due later wait, and run in runAt order", async () => {
      const app = makeApp();
      const later = await app.jobs.enqueue(record, { n: 21 }, { runAt: new Date(Date.now() + 60_000) });
      await app.jobs.enqueue(record, { n: 20 });
      ran.length = 0;
      assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
      assert.deepEqual(ran, ["20:1"]);
      assert.equal((await app.jobs.get(later.id))?.status, "pending");
      assert.deepEqual(await app.jobs.runDue({ now: new Date(Date.now() + 61_000) }), { done: 1, retried: 0, failed: 0 });
      assert.deepEqual(ran, ["20:1", "21:1"]);
    });

    test("retries and failure are recorded", async () => {
      const app = makeApp();
      const queued = await app.jobs.enqueue(record, { n: -1 });
      assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 1, failed: 0 });
      const retrying = (await app.jobs.get(queued.id))!;
      assert.equal(retrying.status, "pending");
      assert.equal(retrying.lastError, "negative -1");
      assert.ok(retrying.runAt.getTime() > Date.now() + 5_000);
      assert.equal(Number(await redis.sendCommand(["PTTL", `inferlo:${name}:jobs:job:${queued.id}`])), -1, "a pending job never expires");
      assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 0, failed: 0 }, "not due yet");
      assert.deepEqual(await app.jobs.runDue({ now: new Date(Date.now() + 11_000) }), { done: 0, retried: 0, failed: 1 });
      const failed = (await app.jobs.get(queued.id))!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.attempts, 2);
    });

    test("instances share the queue and each job runs exactly once", async () => {
      const apps = [makeApp(), makeApp(), makeApp()];
      ran.length = 0;
      for (let n = 100; n < 130; n++) await apps[n % 3]!.jobs.enqueue(record, { n });
      const results = await Promise.all(apps.map((a) => a.jobs.runDue()));
      assert.equal(results.reduce((sum, r) => sum + r.done, 0), 30);
      assert.deepEqual([...ran].sort(), Array.from({ length: 30 }, (_, i) => `${100 + i}:1`).sort());
    });

    test("a worker only claims jobs it has registered", async () => {
      const other = job(`rother-${suffix}`, { input: t.object({}) }).handle(() => {});
      const both = createApp({ name, redis, jobs: [record, other], jobQueue: { store: "redis" }, logger: quiet });
      const queued = await both.jobs.enqueue(other, {});
      assert.deepEqual(await makeApp().jobs.runDue(), { done: 0, retried: 0, failed: 0 });
      assert.equal((await both.jobs.get(queued.id))?.status, "pending");
      assert.deepEqual(await both.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    });

    test("a job left running by a stopped worker is picked up again; without attempts left it is failed", async () => {
      const store = redisJobStore(redis, `inferlo:stale-${suffix}:`, { staleAfterMs: 300 });
      const jobName = `stale-${suffix}`;
      const now = new Date();
      const add = (id: string, maxAttempts: number) => store.add({ id, name: jobName, input: {}, status: "pending", attempts: 0, maxAttempts, runAt: now, createdAt: now, updatedAt: now });
      const crashed = crypto.randomUUID();
      const exhausted = crypto.randomUUID();
      await add(crashed, 3);
      await add(exhausted, 1);
      assert.equal((await store.claim(new Date(), 5, [jobName])).length, 2);
      assert.equal((await store.claim(new Date(), 5, [jobName])).length, 0, "running jobs are not claimed again while fresh");
      await new Promise((r) => setTimeout(r, 450));
      const again = await store.claim(new Date(), 5, [jobName]);
      assert.deepEqual(again.map((r) => [r.id, r.attempts, r.status, r.lastError]), [[crashed, 2, "running", STOPPED_MESSAGE]]);
      const failed = (await store.get(exhausted))!;
      assert.equal(failed.status, "failed");
      assert.equal(failed.lastError, STOPPED_MESSAGE);
    });

    test("a running job that still reports is not picked up again", async () => {
      const store = redisJobStore(redis, `inferlo:touch-${suffix}:`, { staleAfterMs: 1000 });
      const jobName = `slow-${suffix}`;
      const now = new Date();
      const id = crypto.randomUUID();
      await store.add({ id, name: jobName, input: {}, status: "pending", attempts: 0, maxAttempts: 3, runAt: now, createdAt: now, updatedAt: now });
      assert.equal((await store.claim(new Date(), 5, [jobName])).length, 1);
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 250));
        await store.touch!(id);
        assert.equal((await store.claim(new Date(), 5, [jobName])).length, 0);
      }
      await new Promise((r) => setTimeout(r, 1300));
      const reclaimed = await store.claim(new Date(), 5, [jobName]);
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0]!.attempts, 2);
    });

    test("a record whose id is already stored is ignored, and the trace is kept", async () => {
      const store = redisJobStore(redis, `inferlo:dup-${suffix}:`);
      const now = new Date();
      const id = crypto.randomUUID();
      const trace = { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "vendor=1" };
      await store.add({ id, name: "dup", input: { a: 1 }, status: "pending", attempts: 0, maxAttempts: 1, runAt: now, createdAt: now, updatedAt: now, trace });
      await store.add({ id, name: "dup", input: { a: 2 }, status: "pending", attempts: 0, maxAttempts: 1, runAt: now, createdAt: now, updatedAt: now });
      const stored = (await store.get(id))!;
      assert.deepEqual(stored.input, { a: 1 });
      assert.deepEqual(stored.trace, trace);
      assert.equal((await store.claim(new Date(), 5, ["dup"])).length, 1, "queued once");
    });

    test("cron ticks are queued once across instances", async () => {
      const seen: string[] = [];
      const shared = job(`rcron-${suffix}`, { input: t.object({}) }).handle(({ id }) => void seen.push(id));
      const schedule = cron("*/5 * * * *", shared);
      const apps = [0, 1, 2].map(() => createApp({ name: `cron-${suffix}`, redis, jobs: [schedule], jobQueue: { store: "redis" }, logger: quiet }));
      const from = new Date("2031-05-05T10:01:00Z");
      const to = new Date("2031-05-05T10:06:00Z");
      await Promise.all(apps.map((a) => (a.jobs as InternalJobs).queueCrons(from, to)));
      const results = await Promise.all(apps.map((a) => a.jobs.runDue({ now: to })));
      assert.equal(results.reduce((n, r) => n + r.done, 0), 1);
      assert.equal(seen.length, 1);
    });

    test("app.jobs.start() runs queued jobs and stops cleanly", async () => {
      const app = makeApp();
      ran.length = 0;
      const worker = app.jobs.start({ pollMs: 20 });
      const queued = await app.jobs.enqueue(record, { n: 42 });
      for (let i = 0; i < 100 && (await app.jobs.get(queued.id))?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 20));
      await worker.stop();
      assert.equal((await app.jobs.get(queued.id))?.status, "done");
      assert.deepEqual(ran, ["42:1"]);
    });
  });
}
