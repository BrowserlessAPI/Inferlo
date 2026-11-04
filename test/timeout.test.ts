import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, InferloError, memory, model, route, t, type Adapter } from "../src/index.ts";

const quiet = () => {
  const errors: unknown[][] = [];
  return { errors, logger: { info() {}, error: (...args: unknown[]) => void errors.push(args) } };
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

describe("request timeouts", () => {
  test("a handler slower than requestTimeoutMs answers 503 IL2007 and aborts ctx.signal", async () => {
    let aborted: unknown;
    const app = createApp({
      requestTimeoutMs: 50,
      logger: quiet().logger,
      routes: [
        route.get("/slow", { auth: "public" }).handle(async ({ signal }) => {
          signal.addEventListener("abort", () => (aborted = signal.reason));
          await sleep(1000, signal).catch(() => {});
          return { done: true };
        }),
      ],
    });
    const started = Date.now();
    const res = await app.request("/slow");
    assert.ok(Date.now() - started < 900, "answered before the handler finished");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "IL2007");
    assert.match(body.error.message, /50 ms/);
    assert.ok(aborted instanceof InferloError);
    assert.equal((aborted as InferloError).code, "IL2007");
    // Secure headers are still added to the timeout response.
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("fast handlers are not affected and ctx.signal is not aborted", async () => {
    let signalSeen: AbortSignal | undefined;
    const app = createApp({
      requestTimeoutMs: 1000,
      routes: [route.get("/fast", { auth: "public" }).handle(({ signal }) => {
        signalSeen = signal;
        return { ok: true };
      })],
    });
    const res = await app.request("/fast");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok(signalSeen instanceof AbortSignal);
    await sleep(20);
    assert.equal(signalSeen!.aborted, false);
  });

  test("per-route timeoutMs overrides the app default, and false turns it off", async () => {
    const app = createApp({
      requestTimeoutMs: 30,
      logger: quiet().logger,
      routes: [
        route.get("/long", { auth: "public", timeoutMs: 1000 }).handle(async () => {
          await sleep(80);
          return { ok: true };
        }),
        route.get("/never", { auth: "public", timeoutMs: false }).handle(async () => {
          await sleep(80);
          return { ok: true };
        }),
        route.get("/short", { auth: "public", timeoutMs: 10 }).handle(async ({ signal }) => {
          await sleep(500, signal).catch(() => {});
          return { ok: true };
        }),
      ],
    });
    assert.equal((await app.request("/long")).status, 200);
    assert.equal((await app.request("/never")).status, 200);
    const short = await app.request("/short");
    assert.equal(short.status, 503);
    assert.match((await short.json()).error.message, /10 ms/);
  });

  test("requestTimeoutMs: false turns the default off", async () => {
    const app = createApp({ requestTimeoutMs: false, routes: [route.get("/x", { auth: "public" }).handle(() => "ok")] });
    assert.equal(app.describe().requestTimeoutMs, false);
    assert.equal((await app.request("/x")).status, 200);
  });

  test("the default is 60 seconds and describe() shows it, with route overrides", () => {
    const app = createApp({
      routes: [
        route.get("/a", { auth: "public" }).handle(() => "a"),
        route.get("/b", { auth: "public", timeoutMs: 120_000 }).handle(() => "b"),
        route.get("/c", { auth: "public", timeoutMs: false }).handle(() => "c"),
      ],
    });
    const d = app.describe();
    assert.equal(d.requestTimeoutMs, 60_000);
    assert.equal(d.routes.find((r) => r.path === "/a")!.timeoutMs, undefined);
    assert.equal(d.routes.find((r) => r.path === "/b")!.timeoutMs, 120_000);
    assert.equal(d.routes.find((r) => r.path === "/c")!.timeoutMs, false);
  });

  test("ctx.signal is aborted when the client disconnects", async () => {
    let reason: unknown;
    const controller = new AbortController();
    const app = createApp({
      routes: [route.get("/wait", { auth: "public" }).handle(async ({ signal }) => {
        await sleep(1000, signal).catch((e) => (reason = e));
        return { ok: true };
      })],
    });
    const pending = app.fetch(new Request("http://x.test/wait", { signal: controller.signal }));
    await sleep(10);
    controller.abort();
    await pending;
    assert.ok(reason !== undefined, "the handler saw the abort");
  });

  test("ctx.ai calls get ctx.signal, so a timeout stops the model call", async () => {
    let providerSignal: AbortSignal | undefined;
    const provider = {
      name: "mock",
      async generate(req: { signal?: AbortSignal }) {
        providerSignal = req.signal;
        await sleep(1000, req.signal);
        return { text: "late", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const app = createApp({
      requestTimeoutMs: 40,
      logger: quiet().logger,
      ai: { providers: { mock: provider as never }, models: { fast: "mock:test" } },
      routes: [route.get("/ask", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "fast", prompt: "hi" })).text)],
    });
    const res = await app.request("/ask");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "IL2007");
    assert.ok(providerSignal, "the provider got a signal");
    assert.equal(providerSignal!.aborted, true);
  });

  test("an explicit signal passed to ctx.ai wins", async () => {
    let providerSignal: AbortSignal | undefined;
    const own = new AbortController();
    const provider = {
      name: "mock",
      async generate(req: { signal?: AbortSignal }) {
        providerSignal = req.signal;
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const app = createApp({
      ai: { providers: { mock: provider as never }, models: { fast: "mock:test" } },
      routes: [route.get("/ask", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "fast", prompt: "hi", signal: own.signal })).text)],
    });
    assert.equal((await app.request("/ask")).status, 200);
    assert.equal(providerSignal, own.signal);
  });

  test("database calls made after the timeout fail instead of running", async () => {
    const Note = model("notes", { text: t.string() });
    const base = memory();
    let inserts = 0;
    const db: Adapter = { ...base, insert: (m, row) => (inserts++, base.insert(m, row)) };
    let lateError: unknown;
    let finished!: () => void;
    const done = new Promise<void>((r) => (finished = r));
    const app = createApp({
      db,
      models: [Note],
      requestTimeoutMs: 30,
      logger: quiet().logger,
      routes: [route.post("/notes", { auth: "public" }).handle(async ({ db }) => {
        await (db as any).notes.insert({ text: "first" });
        await sleep(80);
        try {
          await (db as any).notes.insert({ text: "second" });
        } catch (error) {
          lateError = error;
        }
        finished();
        return { ok: true };
      })],
    });
    const res = await app.request("/notes", { method: "POST" });
    assert.equal(res.status, 503);
    await done;
    assert.equal(inserts, 1);
    assert.ok(lateError instanceof InferloError);
    assert.equal((lateError as InferloError).code, "IL2007");
    assert.equal((await (app.db as any).notes.findMany()).length, 1);
  });

  test("the timeout covers reading a slow request body", async () => {
    const app = createApp({
      requestTimeoutMs: 40,
      logger: quiet().logger,
      routes: [route.post("/echo", { auth: "public", body: t.object({ a: t.string() }) }).handle(({ body }) => body)],
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        await sleep(300);
        controller.enqueue(new TextEncoder().encode('"b"}'));
        controller.close();
      },
    });
    const res = await app.fetch(new Request("http://x.test/echo", { method: "POST", body: stream, headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "IL2007");
  });

  test("invalid options raise IL6017", () => {
    for (const bad of [0, -1, Number.NaN, Infinity, "1000", true]) {
      assert.throws(() => createApp({ requestTimeoutMs: bad as never }), (e: InferloError) => e.code === "IL6017");
    }
    assert.throws(
      () => createApp({ routes: [route.get("/x", { auth: "public", timeoutMs: -5 }).handle(() => "x")] }),
      (e: InferloError) => e.code === "IL6017" && e.message.includes("GET /x"),
    );
  });
});
