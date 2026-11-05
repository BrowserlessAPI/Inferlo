import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Koa from "koa";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route } from "../src/index.ts";
import { inferloAI, sendResponse, toKoaMiddleware } from "../src/koa.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, error() {} };

function makeAI(reply = '{"label":"bug"}') {
  const usage: { for?: string; model: string }[] = [];
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
  return { ai, usage };
}

async function listen(koa: Koa): Promise<{ base: string; close(): Promise<void> }> {
  const http = koa.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const { port } = http.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

/** What koa-bodyparser and @koa/bodyparser do: read the stream and put the parsed JSON on ctx.request.body. */
const jsonBody: Koa.Middleware = async (ctx, next) => {
  if (ctx.is("application/json")) {
    let raw = "";
    for await (const chunk of ctx.req) raw += chunk;
    (ctx.request as { body?: unknown }).body = raw ? JSON.parse(raw) : {};
  }
  await next();
};

describe("inferloAI() Koa middleware", () => {
  const { ai, usage } = makeAI();
  const stream = makeAI("Hello from the model").ai;
  const koa = new Koa();
  koa.use(jsonBody);
  koa.use(inferloAI(ai));
  koa.use(async (ctx, next) => {
    if (ctx.path === "/classify") {
      // ctx.ai is typed: importing @browserlessapi/inferlo/koa adds it to Koa's context.
      const text = String((ctx.request as { body?: { text?: string } }).body?.text);
      const { object } = await ctx.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }), for: "user-1" });
      ctx.body = object;
      return;
    }
    if (ctx.path === "/chat") return sendResponse(ctx, stream.stream({ model: "fast", prompt: "hi" }).toResponse());
    await next();
  });
  let running: Awaited<ReturnType<typeof listen>>;
  before(async () => void (running = await listen(koa)));
  after(() => running.close());

  test("puts the AI client on ctx.ai, with usage tracked per user", async () => {
    const res = await fetch(`${running.base}/classify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "It crashes" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { label: "bug" });
    assert.equal(usage[0]?.for, "user-1");
  });

  test("sendResponse() streams an AI response as server-sent events", async () => {
    const res = await fetch(`${running.base}/chat`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from the model");
  });

  test("sendResponse() keeps the status and every Set-Cookie header", async () => {
    const app = new Koa();
    app.use((ctx) => {
      const headers = new Headers({ "x-one": "1" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return sendResponse(ctx, new Response("created", { status: 201, headers }));
    });
    const r = await listen(app);
    try {
      const res = await fetch(r.base);
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("x-one"), "1");
      assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
      assert.equal(await res.text(), "created");
    } finally {
      await r.close();
    }
  });

  test("anything that is not an AI client raises IL5014", () => {
    for (const value of [undefined, {}, { generate() {} }, createApp({ logger: quiet })]) {
      assert.throws(
        () => inferloAI(value as never),
        (e: unknown) => e instanceof InferloError && e.code === "IL5014" && Boolean(e.fix?.includes("koa.use(inferloAI(ai))")),
      );
    }
  });
});

describe("toKoaMiddleware(): a whole Inferlo app in Koa", () => {
  const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };
  const ping = route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }));
  const me = route.get("/me").handle(({ user }) => ({ id: user.id }));
  const create = route.post("/notes", { body: t.object({ title: t.string().min(1) }), tool: true }).handle(({ body, status }) => {
    status(201);
    return body;
  });
  const inferlo = createApp({ routes: [{ ping, me, create }], auth: bearer((token) => users[token] ?? null), logger: quiet });

  function host(mount: Koa.Middleware, bodyParser = true) {
    const koa = new Koa();
    if (bodyParser) koa.use(jsonBody);
    koa.use(mount);
    koa.use((ctx) => {
      ctx.body = `koa ${ctx.method} ${ctx.path}`;
    });
    return koa;
  }

  test("under a prefix: routes, auth, validation, OpenAPI and MCP; other paths go on to Koa", async () => {
    for (const bodyParser of [true, false]) {
      const r = await listen(host(toKoaMiddleware(inferlo, { prefix: "/api" }), bodyParser));
      try {
        assert.equal(await (await fetch(`${r.base}/`)).text(), "koa GET /");
        assert.equal(await (await fetch(`${r.base}/apix`)).text(), "koa GET /apix");
        assert.deepEqual(await (await fetch(`${r.base}/api/ping`)).json(), { pong: true });
        assert.equal((await fetch(`${r.base}/api/me`)).status, 401);
        assert.deepEqual(await (await fetch(`${r.base}/api/me`, { headers: { authorization: "Bearer alice" } })).json(), { id: "alice" });
        const headers = { authorization: "Bearer alice", "content-type": "application/json" };
        const bad = await fetch(`${r.base}/api/notes`, { method: "POST", headers, body: "{}" });
        assert.equal(bad.status, 422);
        assert.equal((await bad.json()).error.code, "IL1001");
        const good = await fetch(`${r.base}/api/notes`, { method: "POST", headers, body: JSON.stringify({ title: "Hi" }) });
        assert.equal(good.status, 201, `with body parser: ${bodyParser}`);
        assert.deepEqual(await good.json(), { title: "Hi" });
        assert.equal((await fetch(`${r.base}/api/nothing`)).status, 404, "Inferlo answers its own 404 under the prefix");
        assert.ok((await (await fetch(`${r.base}/api/openapi.json`)).json()).paths["/notes"]);
        const mcp = await fetch(`${r.base}/api/mcp`, {
          method: "POST",
          headers: { ...headers, accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        assert.equal(mcp.status, 200);
        assert.match(await mcp.text(), /create/);
      } finally {
        await r.close();
      }
    }
  });

  test("fallthrough: true answers only the app's routes and passes the rest to Koa at the same URLs", async () => {
    const r = await listen(host(toKoaMiddleware(inferlo, { fallthrough: true })));
    try {
      assert.deepEqual(await (await fetch(`${r.base}/ping`)).json(), { pong: true });
      assert.equal(await (await fetch(`${r.base}/legacy`)).text(), "koa GET /legacy");
      assert.equal(await (await fetch(`${r.base}/ping`, { method: "DELETE" })).text(), "koa DELETE /ping", "other methods on the same path stay in Koa");
    } finally {
      await r.close();
    }
  });

  test("invalid options raise IL5019", () => {
    assert.throws(() => toKoaMiddleware(inferlo, { fallthrough: "yes" as never }), (e: unknown) => e instanceof InferloError && e.code === "IL5019");
    assert.throws(() => toKoaMiddleware({ fetch: inferlo.fetch }, { fallthrough: true }), (e: unknown) => e instanceof InferloError && e.code === "IL5019");
  });
});

test("@browserlessapi/inferlo/koa is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./koa"], { types: "./dist/koa.d.ts", default: "./dist/koa.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "koa.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./ai-client.ts", "./serve.ts"]);
});
