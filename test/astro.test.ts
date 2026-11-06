import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { APIRoute, MiddlewareHandler } from "astro";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createAI, mockProvider } from "../src/ai/public.ts";
import { inferloAI, toAstroHandler } from "../src/astro.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const users = new Map([["demo", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);
const aiConfig = { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } };

function makeApp() {
  const routes = {
    listItems: route.get("/items", { auth: "public", query: t.object({ q: t.string().optional() }) }).handle(({ query }) => ({ items: [], q: query.q ?? null })),
    createItem: route
      .post("/items", { body: t.object({ name: t.string().min(1) }), tool: true })
      .handle(({ body, user, status }) => {
        status(201);
        return { name: body.name, ownerId: user.id };
      }),
    root: route.get("/", { auth: "public" }).handle(() => ({ root: true })),
    limited: route.get("/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true })),
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
  };
  return createApp({ name: "astro-test", routes: [routes], auth: bearer((token) => users.get(token) ?? null), ai: aiConfig });
}

// Astro itself renders the endpoint: the container builds the APIContext the way a server-rendered route gets it.
const container = await AstroContainer.create();
const ALL: APIRoute = toAstroHandler(makeApp(), { prefix: "/api" });
const endpoint = { ALL, prerender: false };
function call(url: string, init?: RequestInit, handler: APIRoute = ALL): Promise<Response> {
  const path = new URL(url).pathname.replace(/^\/api\/?/, "");
  return container.renderToResponse({ ALL: handler, prerender: false } as never, { routeType: "endpoint", request: new Request(url, init), params: { path: path || undefined }, locals: {} } as never);
}

/** An APIContext the way an adapter (server output) gives it, with the client address. */
const context = (url: string, ip: string | (() => string), init?: RequestInit) => {
  const ctx = { request: new Request(url, init), locals: {} };
  Object.defineProperty(ctx, "clientAddress", { get: typeof ip === "function" ? ip : () => ip });
  return ctx as typeof ctx & { clientAddress: string };
};

const json = { "content-type": "application/json" };

describe("toAstroHandler", () => {
  test("is an Astro APIRoute, usable as the ALL export of a catch-all endpoint", () => {
    assert.equal(typeof endpoint.ALL, "function");
  });

  test("routes requests under the prefix with the prefix removed, keeping the query", async () => {
    const res = await call("http://localhost:4321/api/items?q=lamp");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [], q: "lamp" });
    assert.deepEqual(await (await call("http://localhost:4321/api")).json(), { root: true });
  });

  test("keeps auth and validation, and reads the JSON body", async () => {
    const anon = await call("http://localhost/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "Lamp" }) });
    assert.equal(anon.status, 401);
    const headers = { ...json, authorization: "Bearer demo" };
    const invalid = await call("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "" }) });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const created = await call("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "Lamp" }) });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
  });

  test("serves OpenAPI and MCP under the prefix, and answers every method", async () => {
    const doc = await (await call("http://localhost/api/openapi.json")).json();
    assert.ok(doc.paths["/items"].post);
    const mcp = await call("http://localhost/api/mcp", { method: "POST", headers: { ...json, authorization: "Bearer demo" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.deepEqual((await mcp.json()).result.tools.map((x: { name: string }) => x.name), ["createItem"]);
    const other = await call("http://localhost/api/items", { method: "DELETE" });
    assert.equal(other.status, 405);
  });

  test("streams AI responses", async () => {
    const res = await call("http://localhost/api/chat");
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from AI.");
  });

  test("uses Astro's client address for rate limits by IP, and ignores routes without one", async () => {
    const limited = toAstroHandler(makeApp(), { prefix: "/api" });
    assert.equal((await limited(context("http://localhost/api/limited", "198.51.100.1"))).status, 200);
    assert.equal((await limited(context("http://localhost/api/limited", "198.51.100.1"))).status, 429);
    assert.equal((await limited(context("http://localhost/api/limited", "198.51.100.2"))).status, 200);
    const prerendered = context("http://localhost/api/items", () => {
      throw new Error("Astro.clientAddress is only available on pages that are server-rendered.");
    });
    assert.equal((await limited(prerendered)).status, 200);
    // The container has no adapter, so Astro throws on clientAddress there too.
    assert.equal((await call("http://localhost/api/limited", undefined, toAstroHandler(makeApp(), { prefix: "/api" }))).status, 200);
  });

  test("a request outside the prefix keeps its path; without a prefix the request goes to the app unchanged", async () => {
    const outside = await call("http://localhost/other/items");
    assert.equal(outside.status, 404);
    assert.equal((await outside.json()).error.code, "IL2001");
    assert.equal((await call("http://localhost/apix/items")).status, 404);
    const bare = toAstroHandler(makeApp());
    assert.deepEqual(await (await bare(context("http://localhost/items", "127.0.0.1"))).json(), { items: [], q: null });
    const trailing = toAstroHandler(makeApp(), { prefix: "/api/" });
    assert.equal((await trailing(context("http://localhost/api/items", "127.0.0.1"))).status, 200);
  });

  test("invalid arguments and calls without an API context raise IL5028", async () => {
    const fails = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL5028");
    fails(() => toAstroHandler(undefined as never));
    fails(() => toAstroHandler({} as never));
    fails(() => toAstroHandler(makeApp(), { prefix: "api" }));
    fails(() => toAstroHandler(makeApp(), { prefix: 1 as never }));
    fails(() => toAstroHandler(makeApp(), null as never));
    await assert.rejects(toAstroHandler(makeApp())(new Request("http://localhost/api/items") as never), (e: unknown) => e instanceof InferloError && e.code === "IL5028");
  });
});

describe("inferloAI middleware", () => {
  test("puts the AI client on context.locals.ai before the next middleware and the route run", async () => {
    const ai = createAI(aiConfig);
    // Typed as Astro's own MiddlewareHandler, so export const onRequest = inferloAI(ai) and sequence(...) compile.
    const onRequest: MiddlewareHandler = inferloAI(ai);
    const locals = {} as App.Locals;
    let seen: unknown;
    const res = await onRequest({ locals, request: new Request("http://localhost/") } as never, async () => {
      seen = locals.ai;
      return new Response("page");
    });
    assert.equal(await (res as Response).text(), "page");
    assert.equal(seen, ai);
    const { text } = await locals.ai.generate({ model: "fast", prompt: "hi" });
    assert.equal(text, "Hello from AI.");
  });

  test("an endpoint reads context.locals.ai set by the middleware", async () => {
    const ai = createAI(aiConfig);
    const summarize: APIRoute = async ({ locals }) => Response.json({ text: (await locals.ai.generate({ model: "fast", prompt: "hi" })).text });
    const locals = {} as App.Locals;
    await inferloAI(ai)({ locals }, async () => new Response(""));
    const res = await container.renderToResponse({ GET: summarize, prerender: false } as never, { routeType: "endpoint", request: new Request("http://localhost/summary"), locals } as never);
    assert.deepEqual(await res.json(), { text: "Hello from AI." });
  });

  test("also takes an app's app.ai, and anything else raises IL5014", () => {
    assert.equal(typeof inferloAI(makeApp().ai), "function");
    assert.throws(() => inferloAI({} as never), (e: unknown) => e instanceof InferloError && e.code === "IL5014");
  });
});

test("@browserlessapi/inferlo/astro is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./astro"], { types: "./dist/astro.d.ts", default: "./dist/astro.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "astro.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./ai-client.ts", "./client-ip.ts", "./errors.ts", "./serve.ts"]);
});
