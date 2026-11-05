import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RequestHandler } from "@sveltejs/kit";
import type { sequence } from "@sveltejs/kit/hooks";
import { createAI, mockProvider } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";
import { inferloAI, toSvelteKitHandlers, type SvelteKitEventLike } from "../src/sveltekit.ts";

/** SvelteKit's Handle type (exported from "@sveltejs/kit" in SvelteKit 2 and from "@sveltejs/kit/hooks" in 3). */
type Handle = Parameters<typeof sequence>[number];

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
  return createApp({ name: "sveltekit-test", routes: [routes], auth: bearer((token) => users.get(token) ?? null), ai: aiConfig });
}

/** A request event the way SvelteKit builds it for a +server.ts handler. */
function event(url: string, init?: RequestInit, ip = "203.0.113.7"): SvelteKitEventLike {
  return { request: new Request(url, init), getClientAddress: () => ip, locals: {} };
}

const json = { "content-type": "application/json" };

describe("toSvelteKitHandlers", () => {
  const handlers = toSvelteKitHandlers(makeApp(), { prefix: "/api" });
  const { GET, POST, HEAD, fallback } = handlers;

  test("returns a handler per HTTP method and a fallback, typed as SvelteKit's RequestHandler", () => {
    const typed: { [K in keyof typeof handlers]: RequestHandler } = handlers;
    for (const name of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "fallback"] as const) assert.equal(typeof typed[name], "function");
    assert.ok(Object.isFrozen(handlers));
  });

  test("routes requests under the prefix with the prefix removed, keeping the query", async () => {
    const res = await GET(event("http://localhost:5173/api/items?q=lamp"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [], q: "lamp" });
    assert.deepEqual(await (await GET(event("http://localhost:5173/api"))).json(), { root: true });
  });

  test("keeps auth and validation, and reads the JSON body", async () => {
    const anon = await POST(event("http://localhost/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "Lamp" }) }));
    assert.equal(anon.status, 401);
    const headers = { ...json, authorization: "Bearer demo" };
    const invalid = await POST(event("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "" }) }));
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const created = await POST(event("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "Lamp" }) }));
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
  });

  test("serves OpenAPI and MCP under the prefix, answers HEAD, and the fallback takes other methods", async () => {
    const doc = await (await GET(event("http://localhost/api/openapi.json"))).json();
    assert.ok(doc.paths["/items"].post);
    const mcp = await POST(event("http://localhost/api/mcp", { method: "POST", headers: { ...json, authorization: "Bearer demo" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    assert.deepEqual((await mcp.json()).result.tools.map((x: { name: string }) => x.name), ["createItem"]);
    assert.equal((await HEAD(event("http://localhost/api/items", { method: "HEAD" }))).status, 200);
    const other = await fallback(event("http://localhost/api/items", { method: "PROPFIND" }));
    assert.equal(other.status, 405);
  });

  test("uses SvelteKit's client address for rate limits by IP, and ignores adapters without one", async () => {
    const limited = toSvelteKitHandlers(makeApp(), { prefix: "/api" });
    assert.equal((await limited.GET(event("http://localhost/api/limited", undefined, "198.51.100.1"))).status, 200);
    assert.equal((await limited.GET(event("http://localhost/api/limited", undefined, "198.51.100.1"))).status, 429);
    assert.equal((await limited.GET(event("http://localhost/api/limited", undefined, "198.51.100.2"))).status, 200);
    const noAddress = { request: new Request("http://localhost/api/items"), getClientAddress: () => { throw new Error("Cannot read clientAddress during prerendering"); }, locals: {} };
    assert.equal((await limited.GET(noAddress)).status, 200);
  });

  test("streams AI responses", async () => {
    const res = await GET(event("http://localhost/api/chat"));
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from AI.");
  });

  test("a request outside the prefix keeps its path; without a prefix the request goes to the app unchanged", async () => {
    const outside = await GET(event("http://localhost/other/items"));
    assert.equal(outside.status, 404);
    assert.equal((await outside.json()).error.code, "IL2001");
    assert.equal((await GET(event("http://localhost/apix/items"))).status, 404);
    const bare = toSvelteKitHandlers(makeApp());
    assert.deepEqual(await (await bare.GET(event("http://localhost/items"))).json(), { items: [], q: null });
    const trailing = toSvelteKitHandlers(makeApp(), { prefix: "/api/" });
    assert.equal((await trailing.GET(event("http://localhost/api/items"))).status, 200);
  });

  test("invalid arguments and calls without a request event raise IL5022", async () => {
    const fails = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL5022");
    fails(() => toSvelteKitHandlers(undefined as never));
    fails(() => toSvelteKitHandlers({} as never));
    fails(() => toSvelteKitHandlers(makeApp(), { prefix: "api" }));
    fails(() => toSvelteKitHandlers(makeApp(), { prefix: 1 as never }));
    fails(() => toSvelteKitHandlers(makeApp(), null as never));
    await assert.rejects(GET(new Request("http://localhost/api/items") as never), (e: unknown) => e instanceof InferloError && e.code === "IL5022");
  });
});

describe("inferloAI handle hook", () => {
  test("puts the AI client on event.locals.ai before the next hook and the routes run", async () => {
    const ai = createAI(aiConfig);
    // Typed as SvelteKit's own Handle, so export const handle = inferloAI(ai) and sequence(inferloAI(ai), ...) compile.
    const handle: Handle = inferloAI(ai);
    const locals = {} as App.Locals;
    let seen: unknown;
    const res = await handle({
      event: { locals, request: new Request("http://localhost/") } as never,
      resolve: async (e: { locals: App.Locals }) => {
        seen = e.locals.ai;
        return new Response("page");
      },
    });
    assert.equal(await res.text(), "page");
    assert.equal(seen, ai);
    assert.equal(locals.ai, ai);
    const { text } = await locals.ai.generate({ model: "fast", prompt: "hi" });
    assert.equal(text, "Hello from AI.");
  });

  test("also takes an app's app.ai, and anything else raises IL5014", () => {
    assert.equal(typeof inferloAI(makeApp().ai), "function");
    assert.throws(() => inferloAI({} as never), (e: unknown) => e instanceof InferloError && e.code === "IL5014");
  });
});

test("@browserlessapi/inferlo/sveltekit is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./sveltekit"], { types: "./dist/sveltekit.d.ts", default: "./dist/sveltekit.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "sveltekit.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./ai-client.ts", "./client-ip.ts", "./errors.ts", "./serve.ts"]);
});
