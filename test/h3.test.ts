// h3 1 (Nitro 2, Nuxt 3 and 4) and h3 2 (Nitro 3): CI runs this file with the newest h3 1.x and the latest h3.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as h3 from "h3";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route } from "../src/index.ts";
import { inferloAI, toH3Handler, type H3EventLike } from "../src/h3.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, error() {} };
const h3Version = JSON.parse(readFileSync(path.join(repo, "node_modules/h3/package.json"), "utf8")).version as string;
const isH3v1 = h3Version.startsWith("1.");
const lib = h3 as any;

const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };
const ping = route.get("/ping", { auth: "public" }).handle(({ url }) => ({ pong: true, path: url.pathname, q: url.searchParams.get("q") }));
const me = route.get("/me").handle(({ user }) => ({ id: user.id }));
const create = route.post("/notes", { body: t.object({ title: t.string().min(1) }), tool: true }).handle(({ body, status }) => {
  status(201);
  return body;
});
const form = route.post("/form", { auth: "public", body: t.object({ name: t.string() }) }).handle(({ body }) => body);
const chat = route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse());
const inferlo = createApp({
  routes: [{ ping, me, create, form, chat }],
  auth: bearer((token) => users[token] ?? null),
  logger: quiet,
  maxBodySize: 1000,
  ai: { providers: { mock: mockProvider({ respond: () => "Hello from the model" }) }, models: { fast: "mock:m" } },
});
const makeAI = () => createAI({ providers: { mock: mockProvider({ respond: () => '{"label":"bug"}' }) }, models: { fast: "mock:m" } });

/** A Nitro app's request hook, as Nitro runs it before every route. */
function nitroLike() {
  const hooks: ((event: H3EventLike) => void)[] = [];
  return { nitroApp: { hooks: { hook: (_name: "request", fn: (event: H3EventLike) => void) => void hooks.push(fn) } }, run: (event: H3EventLike) => hooks.forEach((fn) => fn(event)) };
}

/** An h3 app the way Nitro builds one: the request hook, a catch-all server route under /api and other routes. */
async function buildH3() {
  const ai = makeAI();
  const nitro = nitroLike();
  inferloAI(ai)(nitro.nitroApp);
  const classify = async (event: H3EventLike & { context: { ai: typeof ai } }) => {
    const { object } = await event.context.ai.generate({ model: "fast", prompt: "It crashes", output: t.object({ label: t.enum(["bug", "feature"]) }) });
    return object;
  };
  if (isH3v1) {
    const app = lib.createApp();
    app.use(lib.eventHandler((event: H3EventLike) => void nitro.run(event)));
    const router = lib.createRouter();
    router.get("/hello", lib.eventHandler(() => ({ from: "h3" })));
    router.get("/classify", lib.eventHandler(classify));
    router.use("/api/**", toH3Handler(inferlo, { prefix: "/api" })); // server/routes/api/[...path].ts
    app.use(router);
    app.use("/v2", toH3Handler(inferlo)); // h3 1 removes the app.use() path itself
    return { listener: lib.toNodeListener(app), ai };
  }
  const app = new lib.H3();
  app.use((event: H3EventLike) => void nitro.run(event));
  app.get("/hello", () => ({ from: "h3" }));
  app.get("/classify", classify);
  app.all("/api/**", toH3Handler(inferlo, { prefix: "/api" }));
  app.all("/v2/**", toH3Handler(inferlo, { prefix: "/v2" }));
  const node = await import("h3/node" as string);
  return { listener: node.toNodeHandler(app), ai, fetch: (req: Request) => app.fetch(req) as Promise<Response> };
}

describe(`toH3Handler and inferloAI on h3 ${h3Version}`, () => {
  let server: Server;
  let base = "";
  let built: Awaited<ReturnType<typeof buildH3>>;
  before(async () => {
    built = await buildH3();
    server = createServer(built.listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test("serves routes, auth and validation under the prefix, next to h3 routes", async () => {
    assert.deepEqual(await (await fetch(`${base}/hello`)).json(), { from: "h3" });
    assert.deepEqual(await (await fetch(`${base}/api/ping?q=1`)).json(), { pong: true, path: "/ping", q: "1" });
    assert.equal((await fetch(`${base}/api/me`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/api/me`, { headers: { authorization: "Bearer alice" } })).json(), { id: "alice" });
    const bad = await fetch(`${base}/api/notes`, { method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, "IL1001");
    const good = await fetch(`${base}/api/notes`, { method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" }, body: JSON.stringify({ title: "Hi" }) });
    assert.equal(good.status, 201);
    assert.deepEqual(await good.json(), { title: "Hi" });
    const missing = await fetch(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "IL2001");
    assert.deepEqual(await (await fetch(`${base}/v2/ping`)).json(), { pong: true, path: "/ping", q: null });
  });

  test("Inferlo reads the body itself: forms and its own size limit", async () => {
    const formRes = await fetch(`${base}/api/form`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=Ada" });
    assert.deepEqual(await formRes.json(), { name: "Ada" });
    const big = await fetch(`${base}/api/form`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(2000) }) });
    assert.equal(big.status, 413);
    assert.equal((await big.json()).error.code, "IL2004");
  });

  test("OpenAPI, MCP and AI streams pass through", async () => {
    assert.ok((await (await fetch(`${base}/api/openapi.json`)).json()).paths["/notes"]);
    const mcp = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer alice", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 200);
    assert.match(await mcp.text(), /create/);
    const stream = await fetch(`${base}/api/chat`);
    assert.match(String(stream.headers.get("content-type")), /text\/event-stream/);
    const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from the model");
  });

  test("the inferloAI() Nitro plugin puts the AI client on event.context.ai", async () => {
    assert.deepEqual(await (await fetch(`${base}/classify`)).json(), { label: "bug" });
  });

  test("works through h3's own fetch on h3 2", { skip: isH3v1 ? "h3 1 has no app.fetch" : false }, async () => {
    const res = await built.fetch!(new Request("http://localhost/api/notes", { method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" }, body: JSON.stringify({ title: "Web" }) }));
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { title: "Web" });
  });
});

test("invalid arguments raise IL5021 or IL5014", async () => {
  const is = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
  assert.throws(() => toH3Handler({} as never), is("IL5021"));
  assert.throws(() => toH3Handler(inferlo, { prefix: "api" }), is("IL5021"));
  assert.throws(() => toH3Handler(inferlo, null as never), is("IL5021"));
  await assert.rejects(toH3Handler(inferlo)({ context: {} }), is("IL5021"));
  assert.throws(() => inferloAI({} as never), is("IL5014"));
});

test("@browserlessapi/inferlo/h3 is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./h3"], { types: "./dist/h3.d.ts", default: "./dist/h3.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src/h3.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./ai-client.ts", "./client-ip.ts", "./errors.ts", "./serve.ts"]);
});
