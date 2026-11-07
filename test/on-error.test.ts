// createApp({ onError }): unexpected errors of routes, WebSocket messages and jobs, with where they happened.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bearer, createApp, httpError, InferloError, job, memory, mockProvider, model, route, t, type ErrorInfo } from "../src/index.ts";

const quiet = { info() {}, error() {} };
const users = new Map([
  ["ada-token", { id: "ada", roles: [] as string[], tenantId: "acme" }],
  ["bob-token", { id: 7 as unknown as string, roles: [] as string[] }],
]);
const auth = bearer((token) => users.get(token) ?? null);
const Note = model("on_error_notes", { title: t.string() }, { tenant: true });

const routes = [
  route.get("/boom/:id", { params: t.object({ id: t.string() }) }).handle(() => {
    throw new Error("could not reach postgres://app:hunter2hunter2@db:5432/app with Bearer abcdefghijklmnop");
  }),
  route.get("/missing", { auth: "public" }).handle(() => {
    throw httpError(404, "Not here");
  }),
  route.get("/bad", { auth: "public", query: t.object({ n: t.int() }) }).handle(() => "ok"),
  route.get("/unavailable", { auth: "public" }).handle(() => {
    throw new InferloError("IL9999", "Upstream down.", { status: 503 });
  }),
  route.get("/ai", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "fast", prompt: "hi" })).text),
  route.get("/fine", { auth: "public" }).handle(() => ({ ok: true })),
];

function makeApp(onError: (error: unknown, info: ErrorInfo) => unknown, logger: { info(message: string): void; error(message: string): void } = quiet) {
  return createApp({
    routes,
    auth,
    models: [Note],
    db: memory(),
    logger,
    onError: onError as never,
    ai: { providers: { mock: mockProvider({ respond: () => { throw new Error("provider exploded"); } }) }, models: { fast: "mock:m" } },
  });
}

describe("createApp({ onError })", () => {
  test("a 500 answer is reported with the request, route, user and tenant, redacted", async () => {
    const seen: [unknown, ErrorInfo][] = [];
    const app = makeApp((error, info) => void seen.push([error, info]));
    const res = await app.fetch(new Request("http://localhost/boom/42?token=x", { headers: { authorization: "Bearer ada-token" } }));
    assert.equal(res.status, 500);
    assert.equal(seen.length, 1);
    const [error, info] = seen[0]!;
    assert.ok(error instanceof Error);
    assert.doesNotMatch((error as Error).message, /hunter2hunter2|abcdefghijklmnop/, "redacted before the hook");
    assert.match((error as Error).message, /\[redacted\]/);
    assert.deepEqual(info, { source: "request", requestId: res.headers.get("x-request-id"), method: "GET", path: "/boom/42", route: "/boom/:id", userId: "ada", tenantId: "acme" });
  });

  test("numeric user ids are strings; anonymous requests have no user", async () => {
    const seen: ErrorInfo[] = [];
    const app = makeApp((_e, info) => void seen.push(info));
    await app.fetch(new Request("http://localhost/boom/1", { headers: { authorization: "Bearer bob-token" } }));
    await app.fetch(new Request("http://localhost/unavailable"));
    assert.equal(seen[0]!.userId, "7");
    assert.equal("tenantId" in seen[0]!, false);
    assert.equal("userId" in seen[1]!, false);
  });

  test("client errors (4xx) are not reported; Inferlo errors with 5xx and failed AI calls are", async () => {
    const seen: [unknown, ErrorInfo][] = [];
    const app = makeApp((error, info) => void seen.push([error, info]));
    assert.equal((await app.fetch(new Request("http://localhost/missing"))).status, 404);
    assert.equal((await app.fetch(new Request("http://localhost/bad?n=x"))).status, 422);
    assert.equal((await app.fetch(new Request("http://localhost/boom/1"))).status, 401);
    assert.equal((await app.fetch(new Request("http://localhost/nowhere"))).status, 404);
    assert.equal((await app.fetch(new Request("http://localhost/fine"))).status, 200);
    assert.equal(seen.length, 0);
    assert.equal((await app.fetch(new Request("http://localhost/unavailable"))).status, 503);
    const ai = await app.fetch(new Request("http://localhost/ai"));
    assert.ok(ai.status >= 500);
    assert.equal(seen.length, 2);
    assert.equal((seen[0]![0] as InferloError).code, "IL9999");
    assert.equal(seen[0]![1].route, "/unavailable");
    assert.ok(seen[1]![0] instanceof Error, "the AI error");
    assert.equal(seen[1]![1].route, "/ai");
  });

  test("errors from middleware are reported without a route", async () => {
    const seen: ErrorInfo[] = [];
    const app = createApp({
      routes,
      auth,
      logger: quiet,
      middleware: [async () => { throw new Error("middleware broke"); }],
      onError: (_e, info) => void seen.push(info),
    });
    assert.equal((await app.fetch(new Request("http://localhost/fine"))).status, 500);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.source, "request");
    assert.equal(seen[0]!.path, "/fine");
  });

  test("a hook that throws or rejects is logged and never changes the answer", async () => {
    const logged: string[] = [];
    const logger = { info() {}, error: (message: string) => void logged.push(message) };
    const throwing = makeApp(() => { throw new Error("tracker down"); }, logger);
    assert.equal((await throwing.fetch(new Request("http://localhost/unavailable"))).status, 503);
    const rejecting = makeApp(async () => { throw new Error("tracker down"); }, logger);
    assert.equal((await rejecting.fetch(new Request("http://localhost/unavailable"))).status, 503);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(logged.filter((m) => m === "createApp({ onError }) failed").length, 2);
  });

  test("failed job attempts are reported with the job, attempt and whether it is final", async () => {
    const seen: [unknown, ErrorInfo][] = [];
    const flaky = job("sync-crm", { input: t.object({}), retries: 1 }).handle(() => {
      throw new Error("CRM timeout");
    });
    const app = createApp({ jobs: [flaky], logger: quiet, onError: (error, info) => void seen.push([error, info]) });
    const { id } = await app.jobs.enqueue(flaky, {});
    await app.jobs.runDue();
    await app.jobs.runDue({ now: new Date(Date.now() + 60_000) });
    assert.equal(seen.length, 2);
    assert.equal((seen[0]![0] as Error).message, "CRM timeout");
    assert.deepEqual(seen[0]![1], { source: "job", job: "sync-crm", jobId: id, attempt: 1, maxAttempts: 2, final: false });
    assert.deepEqual(seen[1]![1], { source: "job", job: "sync-crm", jobId: id, attempt: 2, maxAttempts: 2, final: true });
  });

  test("failed WebSocket messages are reported", async () => {
    const seen: [unknown, ErrorInfo][] = [];
    const ws = route.ws("/live", { message: t.object({ text: t.string() }) }).handle(() => {
      throw new Error("socket handler broke");
    });
    const app = createApp({ routes: [ws], auth, logger: quiet, onError: (error, info) => void seen.push([error, info]) });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const WS = WebSocket as unknown as new (url: string, init?: object) => WebSocket;
      const client = new WS(`ws://127.0.0.1:${server.port}/live`, { headers: { authorization: "Bearer ada-token" } });
      const reply = await new Promise<any>((resolve, reject) => {
        client.onopen = () => client.send(JSON.stringify({ text: "hi" }));
        client.onmessage = (event) => resolve(JSON.parse(String(event.data)));
        client.onerror = () => reject(new Error("socket error"));
      });
      assert.equal(reply.error.code, "IL9000");
      client.close();
      assert.equal(seen.length, 1);
      assert.equal((seen[0]![0] as Error).message, "socket handler broke");
      assert.deepEqual(seen[0]![1], { source: "websocket", requestId: seen[0]![1].requestId, method: "GET", path: "/live", route: "/live", userId: "ada", tenantId: "acme" });
      assert.equal(typeof seen[0]![1].requestId, "string");
    } finally {
      await server.close();
    }
  });

  test("onError must be a function (IL6055)", () => {
    for (const value of [null, "sentry", {}, 1]) {
      assert.throws(() => createApp({ onError: value as never }), (e: unknown) => e instanceof InferloError && e.code === "IL6055");
    }
  });
});
