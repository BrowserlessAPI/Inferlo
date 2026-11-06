import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, InferloError, job, memory, route, t, type Adapter } from "../src/index.ts";

const quiet = () => {
  const errors: unknown[][] = [];
  return { errors, logger: { info() {}, error: (...args: unknown[]) => void errors.push(args) } };
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("graceful shutdown with app.close()", () => {
  test("/ready answers 503 while /health keeps answering 200", async () => {
    const app = createApp({ health: true, logger: quiet().logger });
    assert.equal((await app.request("/ready")).status, 200);
    assert.equal(app.closing, false);
    await app.close();
    assert.equal(app.closing, true);
    const ready = await app.request("/ready");
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: "not_ready", checks: { shutdown: { status: "error", durationMs: 0, error: "The app is shutting down." } } });
    assert.equal((await app.request("/health")).status, 200);
    assert.equal((await app.checkReady()).status, "not_ready");
  });

  test("new requests answer 503 IL2006 with Connection: close", async () => {
    const app = createApp({ routes: [route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }))], logger: quiet().logger });
    assert.equal((await app.request("/ping")).status, 200);
    await app.close();
    const res = await app.request("/ping");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("connection"), "close");
    const body = await res.json();
    assert.equal(body.error.code, "IL2006");
  });

  test("waits for in-flight requests before closing the database", async () => {
    const gate = deferred();
    let closed = false;
    const base = memory();
    const db: Adapter = { ...base, close: async () => void (closed = true) };
    const app = createApp({
      db,
      routes: [route.get("/slow", { auth: "public" }).handle(async () => {
        await gate.promise;
        return { done: true };
      })],
      logger: quiet().logger,
    });
    const inFlight = app.request("/slow");
    await tick();
    let finished = false;
    const closing = app.close().then(() => (finished = true));
    await tick(20);
    assert.equal(finished, false);
    assert.equal(closed, false);
    gate.resolve();
    const res = await inFlight;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { done: true });
    await closing;
    assert.equal(closed, true);
  });

  test("delayMs keeps serving requests after /ready turns 503", async () => {
    const app = createApp({ health: true, routes: [route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }))], logger: quiet().logger });
    const closing = app.close({ delayMs: 60 });
    await tick(5);
    assert.equal((await app.request("/ready")).status, 503);
    assert.equal((await app.request("/ping")).status, 200);
    await closing;
    assert.equal((await app.request("/ping")).status, 503);
  });

  test("gives up waiting after timeoutMs and logs what was still running", async () => {
    const log = quiet();
    let closed = false;
    const db: Adapter = { ...memory(), close: async () => void (closed = true) };
    const app = createApp({
      db,
      routes: [route.get("/stuck", { auth: "public" }).handle(() => new Promise(() => {}))],
      logger: log.logger,
    });
    void app.request("/stuck");
    await tick();
    const started = Date.now();
    await app.close({ timeoutMs: 50 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(closed, true);
    assert.ok(log.errors.some((e) => String(e[0]).includes("1 request(s)")));
  });

  test("waits for waitUntil tasks", async () => {
    const gate = deferred();
    let taskDone = false;
    const app = createApp({
      routes: [route.post("/later", { auth: "public" }).handle((ctx) => {
        ctx.waitUntil(gate.promise.then(() => void (taskDone = true)));
        return { queued: true };
      })],
      logger: quiet().logger,
    });
    assert.equal((await app.request("/later", { method: "POST" })).status, 200);
    const closing = app.close();
    await tick(10);
    assert.equal(taskDone, false);
    gate.resolve();
    await closing;
    assert.equal(taskDone, true);
  });

  test("stops job workers started with app.jobs.start() and waits for the running job", async () => {
    const gate = deferred();
    const started = deferred();
    let finished = false;
    const slow = job("slow-job", { input: t.object({}) }).handle(async () => {
      started.resolve();
      await gate.promise;
      finished = true;
    });
    const app = createApp({ jobs: [slow], logger: quiet().logger });
    await app.jobs.enqueue(slow, {});
    app.jobs.start({ pollMs: 5 });
    await started.promise;
    const closing = app.close();
    await tick(10);
    assert.equal(finished, false);
    gate.resolve();
    await closing;
    assert.equal(finished, true);
    // The worker is stopped: a job queued now stays pending.
    const record = await app.jobs.enqueue(slow, {});
    await tick(30);
    assert.equal((await app.jobs.get(record.id))?.status, "pending");
  });

  test("closes the server started with app.listen()", async () => {
    const app = createApp({ routes: [route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }))], logger: quiet().logger });
    const server = await app.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${server.port}/ping`);
    assert.equal(res.status, 200);
    await res.text();
    await app.close();
    await assert.rejects(fetch(`http://127.0.0.1:${server.port}/ping`));
  });

  const streaming = () =>
    route.get("/stream", { auth: "public" }).handle(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 4; i++) {
                controller.enqueue(new TextEncoder().encode(`chunk ${i}\n`));
                await tick(150);
              }
              controller.close();
            },
          }),
        ),
    );

  test("lets streamed answers from app.listen() finish before the server closes (Node.js and Bun)", async () => {
    const app = createApp({ routes: [streaming()], logger: quiet().logger });
    const server = await app.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${server.port}/stream`);
    const closing = app.close({ timeoutMs: 5_000 });
    assert.equal(await res.text(), "chunk 0\nchunk 1\nchunk 2\nchunk 3\n", "the stream is not cut off");
    await closing;
    await assert.rejects(fetch(`http://127.0.0.1:${server.port}/stream`));
  });

  test("closes connections that are still streaming when timeoutMs is up", async () => {
    const app = createApp({ routes: [route.get("/endless", { auth: "public" }).handle(() => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("start\n")) })))], logger: quiet().logger });
    const server = await app.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${server.port}/endless`);
    const reader = res.body!.getReader();
    await reader.read();
    const started = Date.now();
    await app.close({ timeoutMs: 300 });
    assert.ok(Date.now() - started < 3_000, "close() does not wait for the stream past timeoutMs");
    await assert.rejects(async () => {
      while (!(await reader.read()).done);
      throw new Error("the stream ended normally");
    });
  });

  test("is idempotent and validates its options", async () => {
    const app = createApp({ logger: quiet().logger });
    assert.throws(() => app.close({ timeoutMs: -1 }), (e: unknown) => e instanceof InferloError && e.code === "IL6015");
    assert.throws(() => app.close({ delayMs: Number.NaN }), (e: unknown) => e instanceof InferloError && e.code === "IL6015");
    const first = app.close();
    const second = app.close();
    assert.equal(first, second);
    await first;
  });
});
