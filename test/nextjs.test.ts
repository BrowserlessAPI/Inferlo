import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server.js";
import { mockProvider } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";
import { toNextHandlers } from "../src/nextjs.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const users = new Map([["demo", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

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
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
  };
  return createApp({
    name: "next-test",
    routes: [routes],
    auth: bearer((token) => users.get(token) ?? null),
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
  });
}

const json = { "content-type": "application/json" };

describe("toNextHandlers", () => {
  const { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } = toNextHandlers(makeApp(), { prefix: "/api" });

  test("returns one handler per HTTP method", () => {
    for (const handler of [GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE]) assert.equal(typeof handler, "function");
  });

  test("routes NextRequests under the prefix with the prefix removed, keeping the query", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/api/items?q=lamp"), { params: Promise.resolve({ path: ["items"] }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [], q: "lamp" });
    const root = await GET(new NextRequest("http://localhost:3000/api"));
    assert.deepEqual(await root.json(), { root: true });
  });

  test("keeps auth and validation, and reads the JSON body", async () => {
    const anon = await POST(new NextRequest("http://localhost/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "Lamp" }) }));
    assert.equal(anon.status, 401);
    const headers = { ...json, authorization: "Bearer demo" };
    const invalid = await POST(new NextRequest("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "" }) }));
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const created = await POST(new NextRequest("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "Lamp" }) }));
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
  });

  test("serves OpenAPI and MCP under the prefix, and answers HEAD", async () => {
    const doc = await (await GET(new NextRequest("http://localhost/api/openapi.json"))).json();
    assert.ok(doc.paths["/items"].post);
    const mcp = await POST(new NextRequest("http://localhost/api/mcp", { method: "POST", headers: { ...json, authorization: "Bearer demo" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    assert.deepEqual((await mcp.json()).result.tools.map((x: { name: string }) => x.name), ["createItem"]);
    const head = await HEAD(new NextRequest("http://localhost/api/items", { method: "HEAD" }));
    assert.equal(head.status, 200);
  });

  test("streams AI responses", async () => {
    const res = await GET(new NextRequest("http://localhost/api/chat"));
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from AI.");
  });

  test("a request outside the prefix keeps its path, and a plain Request works too", async () => {
    const outside = await GET(new NextRequest("http://localhost/other/items"));
    assert.equal(outside.status, 404);
    assert.equal((await outside.json()).error.code, "IL2001");
    const plain = await GET(new Request("http://localhost/api/items"));
    assert.equal(plain.status, 200);
    // "/apix" is not under "/api".
    assert.equal((await GET(new Request("http://localhost/apix/items"))).status, 404);
  });

  test("without a prefix, the request goes to the app unchanged", async () => {
    const handlers = toNextHandlers(makeApp());
    assert.deepEqual(await (await handlers.GET(new NextRequest("http://localhost/items"))).json(), { items: [], q: null });
    const trailing = toNextHandlers(makeApp(), { prefix: "/api/" });
    assert.equal((await trailing.GET(new NextRequest("http://localhost/api/items"))).status, 200);
  });

  test("invalid arguments raise IL5020", () => {
    const fails = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL5020");
    fails(() => toNextHandlers(undefined as never));
    fails(() => toNextHandlers({} as never));
    fails(() => toNextHandlers(makeApp(), { prefix: "api" }));
    fails(() => toNextHandlers(makeApp(), { prefix: 1 as never }));
    fails(() => toNextHandlers(makeApp(), null as never));
  });
});

test("@browserlessapi/inferlo/nextjs is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./nextjs"], { types: "./dist/nextjs.d.ts", default: "./dist/nextjs.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "nextjs.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./errors.ts"]);
});
