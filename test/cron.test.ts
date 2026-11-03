import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { createApp, cron, InferloError, isCron, job, memory, t, type Adapter } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { parseCron } from "../src/cron.ts";
import type { InternalJobs } from "../src/jobs.ts";

const quiet = { info: () => {}, error: () => {} };
const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const iso = (d: Date) => d.toISOString();
const next = (schedule: string, after: string) => iso(parseCron(schedule)(new Date(after)));

describe("cron schedules", () => {
  test("next tick in UTC for common schedules", () => {
    assert.equal(next("0 * * * *", "2030-01-01T10:15:30Z"), "2030-01-01T11:00:00.000Z");
    assert.equal(next("0 * * * *", "2030-01-01T11:00:00Z"), "2030-01-01T12:00:00.000Z", "strictly after");
    assert.equal(next("*/15 * * * *", "2030-01-01T10:15:00Z"), "2030-01-01T10:30:00.000Z");
    assert.equal(next("* * * * *", "2030-01-01T10:15:59.999Z"), "2030-01-01T10:16:00.000Z");
    assert.equal(next("30 3 * * 1-5", "2030-01-04T04:00:00Z"), "2030-01-07T03:30:00.000Z", "Friday after 03:30 -> Monday");
    assert.equal(next("0 0 1 * *", "2030-01-31T12:00:00Z"), "2030-02-01T00:00:00.000Z");
    assert.equal(next("0 9 * jan,jul mon", "2030-02-01T00:00:00Z"), "2030-07-01T09:00:00.000Z");
    assert.equal(next("0 0 * * 7", "2030-01-01T00:00:00Z"), "2030-01-06T00:00:00.000Z", "7 is Sunday");
    assert.equal(next("0 0 29 2 *", "2030-03-01T00:00:00Z"), "2032-02-29T00:00:00.000Z");
    assert.equal(next("5/20 1-3 * * *", "2030-01-01T02:50:00Z"), "2030-01-01T03:05:00.000Z");
    // Both day fields restricted: either one matches (standard cron).
    assert.equal(next("0 0 15 * mon", "2030-01-01T00:00:00Z"), "2030-01-07T00:00:00.000Z");
    assert.equal(next("  0   12 * * *  ", "2030-01-01T00:00:00Z"), "2030-01-01T12:00:00.000Z");
  });

  test("invalid schedules and jobs raise IL6013", () => {
    const empty = job("cron-empty", { input: t.object({}) }).handle(() => {});
    const needsInput = job("cron-needs-input", { input: t.object({ id: t.uuid() }) }).handle(() => {});
    const bad = ["0 * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-1 * * * *", "x * * * *", "0 0 31 2 *", "1-2-3 * * * *"];
    for (const schedule of bad) {
      assert.throws(() => cron(schedule, empty), (e: unknown) => e instanceof InferloError && e.code === "IL6013", schedule);
    }
    assert.throws(() => cron("0 * * * *", {} as never), (e: unknown) => e instanceof InferloError && e.code === "IL6013" && /needs a job/.test(e.message));
    assert.throws(() => cron("0 * * * *", needsInput), (e: unknown) => e instanceof InferloError && e.code === "IL6013" && /does not accept \{\}/.test(e.message));
    const ok = cron(" 0  *  * * * ", empty);
    assert.ok(isCron(ok));
    assert.equal(ok.schedule, "0 * * * *");
    assert.equal(iso(ok.next(new Date("2030-01-01T00:30:00Z"))), "2030-01-01T01:00:00.000Z");
  });
});

describe("cron in the app", () => {
  const runs: string[] = [];
  const report = job("cron-report", { input: t.object({}) }).handle(({ id }) => void runs.push(id));
  const hourly = cron("0 * * * *", report);

  test("crons are registered from modules with their job, and describe lists them", () => {
    // Only the cron is exported: its job is registered with it.
    const app = createApp({ jobs: [{ hourly }], logger: quiet });
    assert.deepEqual(app.jobs.list.map((j) => j.name), ["cron-report"]);
    assert.equal(app.jobs.crons.length, 1);
    assert.deepEqual(app.describe().crons, [{ schedule: "0 * * * *", job: "cron-report" }]);
  });

  test("the latest tick in a window is queued once, with a fixed id per tick", async () => {
    const app = createApp({ db: memory(), jobs: [{ hourly, report }], logger: quiet });
    const jobs = app.jobs as InternalJobs;
    runs.length = 0;
    // No tick between 10:01 and 10:59.
    await jobs.queueCrons(new Date("2030-01-01T10:01:00Z"), new Date("2030-01-01T10:59:00Z"));
    assert.deepEqual(await app.jobs.runDue({ now: new Date("2030-01-01T11:00:00Z") }), { done: 0, retried: 0, failed: 0 });
    // Three ticks passed (11:00, 12:00, 13:00) while paused: only 13:00 is queued.
    await jobs.queueCrons(new Date("2030-01-01T10:59:00Z"), new Date("2030-01-01T13:00:30Z"));
    await jobs.queueCrons(new Date("2030-01-01T10:59:00Z"), new Date("2030-01-01T13:00:30Z")); // again: same id, ignored
    assert.deepEqual(await app.jobs.runDue({ now: new Date("2030-01-01T13:00:30Z") }), { done: 1, retried: 0, failed: 0 });
    const record = await app.jobs.get(runs[0]!);
    assert.equal(record?.runAt.toISOString(), "2030-01-01T13:00:00.000Z");
    assert.equal(record?.name, "cron-report");
    // Even after it ran, the same tick is not queued again.
    await jobs.queueCrons(new Date("2030-01-01T12:59:00Z"), new Date("2030-01-01T13:30:00Z"));
    assert.deepEqual(await app.jobs.runDue({ now: new Date("2030-01-01T13:30:00Z") }), { done: 0, retried: 0, failed: 0 });
  });

  test("start() queues ticks after it starts", async () => {
    const every = job("cron-every-minute", { input: t.object({}) }).handle(() => {});
    const app = createApp({ jobs: [cron("* * * * *", every)], logger: quiet });
    // The worker only queues ticks after its start, so a tick in the past is never run.
    const worker = app.jobs.start({ pollMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    await worker.stop();
    assert.deepEqual(await app.jobs.runDue({ now: new Date(Date.now() - 1) }), { done: 0, retried: 0, failed: 0 });
  });

  if (PG_URL) {
    const adapters: Adapter[] = [];
    after(async () => {
      for (const a of adapters) await a.close?.();
    });
    test("with the database queue, every instance can run the schedule and each tick is queued once", async () => {
      const name = `cron-shared-${Date.now().toString(36)}`;
      const seen: string[] = [];
      const shared = job(name, { input: t.object({}) }).handle(({ id }) => void seen.push(id));
      const schedule = cron("*/5 * * * *", shared);
      const apps = [0, 1, 2].map(() => {
        const db = postgres({ url: PG_URL });
        adapters.push(db);
        return createApp({ db, jobs: [schedule], jobQueue: { store: "database" }, logger: quiet });
      });
      const from = new Date("2031-05-05T10:01:00Z");
      const to = new Date("2031-05-05T10:06:00Z");
      await Promise.all(apps.map((a) => (a.jobs as InternalJobs).queueCrons(from, to)));
      const results = await Promise.all(apps.map((a) => a.jobs.runDue({ now: to })));
      assert.equal(results.reduce((n, r) => n + r.done, 0), 1);
      assert.equal(seen.length, 1);
    });
  }
});
