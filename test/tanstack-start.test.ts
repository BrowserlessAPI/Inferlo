import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRootRoute, createRoute } from "@tanstack/react-router";
// TanStack Start adds the server option of routes to TanStack Router's types.
import type {} from "@tanstack/react-start";
import { mockProvider } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";
import { toTanStackHandlers } from "../src/tanstack-start.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const users = new Map([["demo", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);
// TanStack Start's handler needs Node.js module hooks to load its virtual entries; Bun and Deno run the other tests.
// (Older Bun releases ignore node:test's skip option, so the test is only declared on Node.js.)
const isNode = !("Bun" in globalThis) && !("Deno" in globalThis);

function makeApp(cors = false) {
  const routes = {
    listItems: route.get("/items", { auth: "public", query: t.object({ q: t.string().optional() }) }).handle(({ query }) => ({ items: [], q: query.q ?? null })),
    createItem: route
      .post("/items", { body: t.object({ name: t.string().min(1) }), tool: true })
      .handle(({ body, user, status }) => {
        status(201);
        return { name: body.name, ownerId: user.id };
      }),
    removeItem: route.delete("/items/:id").handle(({ params }) => ({ deleted: params.id })),
    root: route.get("/", { auth: "public" }).handle(() => ({ root: true })),
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
  };
  return createApp({
    name: "tanstack-start-test",
    routes: [routes],
    auth: bearer((token) => users.get(token) ?? null),
    cors: cors ? { origin: "https://app.example.com" } : undefined,
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
  });
}

/** The route tree of a project with src/routes/api/$.ts, as TanStack Router's generator builds it. */
function routeTree(app = makeApp(), prefix = "/api") {
  const root = createRootRoute();
  const api = createRoute({ getParentRoute: () => root, path: "/api/$", server: { handlers: toTanStackHandlers(app, { prefix }) } } as any);
  return root.addChildren([api]);
}

/** TanStack Start's own request handler with a router entry whose getRouter uses tree. */
async function start(tree: ReturnType<typeof routeTree>) {
  const routerEntry = new URL("./fixtures/tanstack-start/router-entry.ts", import.meta.url);
  const { setRouteTree } = await import(routerEntry.href);
  setRouteTree(tree);
  const { startHandler } = await import("./fixtures/tanstack-start/start-handler.ts");
  return startHandler(routerEntry.href);
}

const json = { "content-type": "application/json" };

describe("toTanStackHandlers", () => {
  test("returns one handler per method, accepted as TanStack Start server route handlers", () => {
    const handlers = toTanStackHandlers(makeApp());
    assert.deepEqual(Object.keys(handlers).sort(), ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
    assert.ok(Object.isFrozen(handlers));
    const root = createRootRoute();
    // Type check: the handlers fit createRoute's (and createFileRoute's) server.handlers option.
    const apiRoute = createRoute({ getParentRoute: () => root, path: "/api/$", server: { handlers } });
    assert.equal(apiRoute.options.server?.handlers, handlers);
  });

  test("runs the app with the prefix removed: params, query, body, auth and status", async () => {
    const { POST, GET, DELETE } = toTanStackHandlers(makeApp(), { prefix: "/api" });
    const list = await GET({ request: new Request("http://localhost:3000/api/items?q=hello") });
    assert.deepEqual(await list.json(), { items: [], q: "hello" });
    const anon = await POST({ request: new Request("http://localhost:3000/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "a" }) }) });
    assert.equal(anon.status, 401);
    const created = await POST({ request: new Request("http://localhost:3000/api/items", { method: "POST", headers: { ...json, authorization: "Bearer demo" }, body: JSON.stringify({ name: "Lamp" }) }) });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
    const invalid = await POST({ request: new Request("http://localhost:3000/api/items", { method: "POST", headers: { ...json, authorization: "Bearer demo" }, body: JSON.stringify({ name: "" }) }) });
    assert.equal(invalid.status, 422);
    const removed = await DELETE({ request: new Request("http://localhost:3000/api/items/7", { method: "DELETE", headers: { authorization: "Bearer demo" } }) });
    assert.deepEqual(await removed.json(), { deleted: "7" });
    assert.deepEqual(await (await GET({ request: new Request("http://localhost:3000/api") })).json(), { root: true });
    const missing = await GET({ request: new Request("http://localhost:3000/api/nope") });
    assert.equal(missing.status, 404);
  });

  test("serves OpenAPI and MCP under the prefix, and keeps requests outside it unchanged", async () => {
    const { GET } = toTanStackHandlers(makeApp(), { prefix: "/api/" });
    const doc = await (await GET({ request: new Request("http://localhost/api/openapi.json") })).json();
    assert.ok(doc.paths["/items"].post);
    const outside = await GET({ request: new Request("http://localhost/apix/items") });
    assert.equal(outside.status, 404);
    const plain = toTanStackHandlers(makeApp());
    assert.deepEqual(await (await plain.GET({ request: new Request("http://localhost/items") })).json(), { items: [], q: null });
  });

  test("streams AI answers and answers CORS preflights and HEAD requests", async () => {
    const { GET, OPTIONS, HEAD } = toTanStackHandlers(makeApp(true), { prefix: "/api" });
    const stream = await GET({ request: new Request("http://localhost/api/chat") });
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from AI.");
    const preflight = await OPTIONS({
      request: new Request("http://localhost/api/items", { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } }),
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example.com");
    const head = await HEAD({ request: new Request("http://localhost/api/items", { method: "HEAD" }) });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("cancels the app's work when the browser goes away", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const app = createApp({ routes: [route.get("/slow", { auth: "public" }).handle(({ signal }) => ((seen = signal), { ok: true }))] });
    const { GET } = toTanStackHandlers(app, { prefix: "/api" });
    await GET({ request: new Request("http://localhost/api/slow", { signal: controller.signal }) });
    controller.abort();
    assert.equal(seen?.aborted, true);
  });

  test("invalid arguments raise IL5036", async () => {
    assert.throws(() => toTanStackHandlers(undefined as never), (e: unknown) => e instanceof InferloError && e.code === "IL5036");
    assert.throws(() => toTanStackHandlers({} as never), (e: unknown) => e instanceof InferloError && e.code === "IL5036");
    assert.throws(() => toTanStackHandlers(makeApp(), { prefix: "api" }), (e: unknown) => e instanceof InferloError && e.code === "IL5036");
    assert.throws(() => toTanStackHandlers(makeApp(), null as never), (e: unknown) => e instanceof InferloError && e.code === "IL5036");
    const { GET } = toTanStackHandlers(makeApp());
    await assert.rejects(GET({} as never), (e: unknown) => e instanceof InferloError && e.code === "IL5036");
  });

  test("never loads TanStack Start, React or Inferlo's router by itself", () => {
    const source = readFileSync(path.join(repo, "src", "tanstack-start.ts"), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./app.ts", "./errors.ts", "./serve.ts"]);
    assert.ok(source.includes('import type { App } from "./app.ts"'), "the app is a type-only import");
  });
});

if (isNode) {
  describe("in TanStack Start's own request handler", () => {
    test("a splat server route at /api/$ serves the whole app", async () => {
      const fetch = await start(routeTree());
      const doc = await fetch(new Request("http://localhost:3000/api/openapi.json"));
      assert.equal(doc.status, 200);
      assert.ok((await doc.json()).paths["/items"]);
      const list = await fetch(new Request("http://localhost:3000/api/items?q=x"));
      assert.deepEqual(await list.json(), { items: [], q: "x" });
      const anon = await fetch(new Request("http://localhost:3000/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "a" }) }));
      assert.equal(anon.status, 401);
      assert.equal((await anon.json()).error.code, "IL3001");
      const created = await fetch(new Request("http://localhost:3000/api/items", { method: "POST", headers: { ...json, authorization: "Bearer demo" }, body: JSON.stringify({ name: "Lamp" }) }));
      assert.equal(created.status, 201);
      assert.equal((await created.json()).name, "Lamp");
      const removed = await fetch(new Request("http://localhost:3000/api/items/3", { method: "DELETE", headers: { authorization: "Bearer demo" } }));
      assert.deepEqual(await removed.json(), { deleted: "3" });
      assert.deepEqual(await (await fetch(new Request("http://localhost:3000/api"))).json(), { root: true });
      const stream = await fetch(new Request("http://localhost:3000/api/chat"));
      assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
      const text = [...(await stream.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
      assert.equal(text, "Hello from AI.");
      const head = await fetch(new Request("http://localhost:3000/api/items", { method: "HEAD" }));
      assert.equal(head.status, 200);
    });
  });
}
