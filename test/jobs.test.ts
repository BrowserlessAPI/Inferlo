import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, InferloError, job, memory, mockProvider, model, retryDelayMs, route, t, type AppDb, type Db, type JobInput } from "../src/index.ts";

const Note = model("job_notes", { title: t.string().max(200), words: t.int().optional() });
const models = [Note] as const;
const quiet = { info: () => {}, error: () => {} };
const typed = (db: AppDb) => db as unknown as Db<typeof models>;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>() => void 0 as unknown as T;

const countWords = job("count-words", { input: t.object({ noteId: t.uuid() }), summary: "Count the words of a note" }).handle(async ({ input, db }) => {
  const note = await typed(db).job_notes.get(input.noteId);
  await typed(db).job_notes.update(note.id, { words: note.title.split(/\s+/).filter(Boolean).length });
});

let flakyRuns = 0;
const flaky = job("flaky", { input: t.object({ failTimes: t.int() }), retries: 2 }).handle(({ input, attempt }) => {
  flakyRuns++;
  if (attempt <= input.failTimes) throw new Error(`boom ${attempt}`);
});

const createNote = route.post("/notes", { auth: "public", body: t.object({ title: t.string().max(200) }) }).handle(async ({ body, db, jobs, status }) => {
  const note = await typed(db).job_notes.insert(body);
  await jobs.enqueue(countWords, { noteId: note.id });
  status(201);
  return note;
});

function makeApp(extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ models, routes: [createNote], jobs: [{ countWords, flaky }], db: memory(), logger: quiet, ...extra });
}

describe("jobs", () => {
  test("a route enqueues a job; it runs later with the validated input and the database", async () => {
    const app = makeApp();
    const res = await app.request("/notes", { method: "POST", json: { title: "one two three" } });
    assert.equal(res.status, 201);
    const note = await res.json();
    assert.equal((await app.db.job_notes.get(note.id)).words ?? null, null);
    assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    assert.equal((await app.db.job_notes.get(note.id)).words, 3);
    assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 0, failed: 0 });
  });

  test("enqueue validates input (IL1001) and returns the record; the input type comes from the schema", async () => {
    const app = makeApp();
    await assert.rejects(app.jobs.enqueue(countWords, { noteId: "nope" }), (e: unknown) => e instanceof InferloError && e.code === "IL1001" && /input for job "count-words"/.test(e.message));
    // @ts-expect-error noteId is required
    await assert.rejects(app.jobs.enqueue(countWords, {}), (e: unknown) => e instanceof InferloError && e.code === "IL1001");
    assertType<Equal<JobInput<typeof countWords>, { noteId: string }>>();
    const record = await app.jobs.enqueue(countWords, { noteId: crypto.randomUUID() });
    assert.equal(record.name, "count-words");
    assert.equal(record.status, "pending");
    assert.equal(record.attempts, 0);
    assert.equal(record.maxAttempts, 4);
    assert.equal((await app.jobs.get(record.id))?.status, "pending");
    assert.equal(await app.jobs.get(crypto.randomUUID()), null);
  });

  test("failures are retried with growing delays, then marked failed", async () => {
    const app = makeApp();
    flakyRuns = 0;
    const start = new Date("2030-01-01T00:00:00Z");
    const ok = await app.jobs.enqueue(flaky, { failTimes: 1 }, { runAt: start });
    const bad = await app.jobs.enqueue(flaky, { failTimes: 5 }, { runAt: start });
    assert.deepEqual(await app.jobs.runDue({ now: new Date(start.getTime() - 1) }), { done: 0, retried: 0, failed: 0 });

    assert.deepEqual(await app.jobs.runDue({ now: start }), { done: 0, retried: 2, failed: 0 });
    const afterFirst = (await app.jobs.get(ok.id))!;
    assert.equal(afterFirst.status, "pending");
    assert.equal(afterFirst.attempts, 1);
    assert.equal(afterFirst.lastError, "boom 1");
    assert.equal(afterFirst.runAt.getTime(), start.getTime() + 10_000);

    // Not due yet.
    assert.deepEqual(await app.jobs.runDue({ now: new Date(start.getTime() + 9_999) }), { done: 0, retried: 0, failed: 0 });
    assert.deepEqual(await app.jobs.runDue({ now: new Date(start.getTime() + 10_000) }), { done: 1, retried: 1, failed: 0 });
    assert.equal((await app.jobs.get(ok.id))!.status, "done");
    assert.equal((await app.jobs.get(bad.id))!.runAt.getTime(), start.getTime() + 10_000 + 20_000);

    assert.deepEqual(await app.jobs.runDue({ now: new Date(start.getTime() + 30_000) }), { done: 0, retried: 0, failed: 1 });
    const failed = (await app.jobs.get(bad.id))!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 3);
    assert.equal(failed.lastError, "boom 3");
    assert.equal(flakyRuns, 5);
    assert.deepEqual(await app.jobs.runDue({ now: new Date(start.getTime() + 999_999_999) }), { done: 0, retried: 0, failed: 0 });
    assert.deepEqual([1, 2, 3, 10, 20].map(retryDelayMs), [10_000, 20_000, 40_000, 3_600_000, 3_600_000]);
  });

  test("input is stored as JSON and parsed again when the job runs (dates and defaults)", async () => {
    const seen: unknown[] = [];
    const remind = job("remind", { input: t.object({ at: t.date(), tag: t.string().default("x") }), retries: 0 }).handle(({ input }) => void seen.push(input));
    const app = createApp({ jobs: [remind], logger: quiet });
    const record = await app.jobs.enqueue(remind, { at: new Date("2030-01-01T00:00:00Z") });
    assert.deepEqual(record.input, { at: "2030-01-01T00:00:00.000Z", tag: "x" });
    await app.jobs.runDue();
    assert.ok((seen[0] as { at: Date }).at instanceof Date);
    assert.equal((seen[0] as { tag: string }).tag, "x");
  });

  test("jobs get ai and jobs in their context, and can enqueue follow-up jobs", async () => {
    const order: string[] = [];
    const second = job("second", { input: t.object({ text: t.string() }) }).handle(({ input }) => void order.push(`second:${input.text}`));
    const first = job("first", { input: t.object({}) }).handle(async ({ ai, jobs, attempt, id }) => {
      assert.equal(attempt, 1);
      assert.equal(typeof id, "string");
      const { text } = await ai.generate({ model: "fast", prompt: "hi" });
      order.push(`first:${text}`);
      await jobs.enqueue(second, { text });
    });
    const app = createApp({ jobs: [[first, second]], logger: quiet, ai: { providers: { mock: mockProvider({ respond: () => "hello" }) }, models: { fast: "mock:m" } } });
    await app.jobs.enqueue(first, {});
    assert.deepEqual(await app.jobs.runDue(), { done: 2, retried: 0, failed: 0 });
    assert.deepEqual(order, ["first:hello", "second:hello"]);
  });

  test("start() runs due jobs in the background until stop()", async () => {
    const app = makeApp();
    const note = await app.db.job_notes.insert({ title: "a b" });
    const worker = app.jobs.start({ pollMs: 5 });
    await app.jobs.enqueue(countWords, { noteId: note.id });
    for (let i = 0; i < 100 && (await app.db.job_notes.get(note.id)).words == null; i++) await new Promise((r) => setTimeout(r, 5));
    await worker.stop();
    assert.equal((await app.db.job_notes.get(note.id)).words, 2);
  });

  test("invalid jobs raise IL6009, unregistered jobs IL6010", async () => {
    assert.throws(() => job("Send Email", { input: t.object({}) }), (e: unknown) => e instanceof InferloError && e.code === "IL6009");
    assert.throws(() => job("x", { input: t.object({}), retries: -1 }), (e: unknown) => e instanceof InferloError && e.code === "IL6009" && /retries/.test(e.message));
    assert.throws(() => job("x", {} as never), (e: unknown) => e instanceof InferloError && e.code === "IL6009" && /input must be a schema/.test(e.message));
    const twin = job("count-words", { input: t.object({}) }).handle(() => {});
    assert.throws(() => createApp({ jobs: [countWords, twin] }), (e: unknown) => e instanceof InferloError && e.code === "IL6009" && /Two jobs/.test(e.message));
    const app = createApp({ jobs: [countWords], logger: quiet });
    await assert.rejects(app.jobs.enqueue(flaky, { failTimes: 0 }), (e: unknown) => e instanceof InferloError && e.code === "IL6010" && /"flaky"/.test(e.message));
    await assert.rejects(app.jobs.enqueue(countWords, { noteId: crypto.randomUUID() }, { runAt: new Date("nope") }), (e: unknown) => e instanceof InferloError && e.code === "IL6009");
  });

  test("describe lists jobs", () => {
    const app = makeApp();
    const jobs = app.describe().jobs;
    assert.deepEqual(jobs.map((j) => [j.name, j.retries, j.summary]), [["count-words", 3, "Count the words of a note"], ["flaky", 2, undefined]]);
    assert.equal(jobs[0]!.input.type, "object");
  });
});
