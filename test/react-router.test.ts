import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createStaticHandler, type ActionFunction, type LoaderFunction } from "react-router";
import { mockProvider } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";
import { toReactRouterHandlers } from "../src/react-router.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const users = new Map([["demo", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

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
    name: "react-router-test",
    routes: [routes],
    auth: bearer((token) => users.get(token) ?? null),
    cors: cors ? { origin: "https://app.example.com" } : undefined,
    ai: { providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } },
  });
}

/** React Router's own data router, with the splat resource route at /api/* the way app/routes.ts declares it. */
function router(app = makeApp(), prefix = "/api") {
  const { loader, action } = toReactRouterHandlers(app, { prefix });
  const handler = createStaticHandler([{ id: "api", path: "/api/*", loader, action }]);
  return async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      return (await handler.queryRoute(new Request(url, init))) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  };
}

const json = { "content-type": "application/json" };

describe("toReactRouterHandlers", () => {
  const request = router();

  test("returns a loader and an action typed as React Router's LoaderFunction and ActionFunction", () => {
    const handlers = toReactRouterHandlers(makeApp());
    const loader: LoaderFunction = handlers.loader;
    const action: ActionFunction = handlers.action;
    assert.equal(typeof loader, "function");
    assert.equal(typeof action, "function");
    assert.ok(Object.isFrozen(handlers));
  });

  test("the loader serves GET and HEAD under the prefix with the prefix removed, keeping the query", async () => {
    const res = await request("http://localhost:5173/api/items?q=lamp");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { items: [], q: "lamp" });
    assert.deepEqual(await (await request("http://localhost:5173/api/")).json(), { root: true });
    const head = await request("http://localhost:5173/api/items", { method: "HEAD" });
    assert.equal(head.status, 200);
  });

  test("the action keeps auth and validation, reads the JSON body and serves PUT, PATCH and DELETE", async () => {
    const anon = await request("http://localhost/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "Lamp" }) });
    assert.equal(anon.status, 401);
    const headers = { ...json, authorization: "Bearer demo" };
    const invalid = await request("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "" }) });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const created = await request("http://localhost/api/items", { method: "POST", headers, body: JSON.stringify({ name: "Lamp" }) });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
    const removed = await request("http://localhost/api/items/7", { method: "DELETE", headers });
    assert.deepEqual(await removed.json(), { deleted: "7" });
    const put = await request("http://localhost/api/items", { method: "PUT", headers, body: "{}" });
    assert.equal(put.status, 405);
    assert.equal((await put.json()).error.code, "IL2002");
  });

  test("serves OpenAPI and MCP under the prefix, and streams AI responses", async () => {
    const doc = await (await request("http://localhost/api/openapi.json")).json();
    assert.ok(doc.paths["/items"].post);
    const mcp = await request("http://localhost/api/mcp", { method: "POST", headers: { ...json, authorization: "Bearer demo" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.deepEqual((await mcp.json()).result.tools.map((x: { name: string }) => x.name), ["createItem"]);
    const res = await request("http://localhost/api/chat");
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from AI.");
  });

  test("CORS preflights (OPTIONS) reach the app through the action", async () => {
    const res = await router(makeApp(true))("http://localhost/api/items", { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example.com");
  });

  test("calls outside the prefix keep their path; without a prefix the request goes to the app unchanged", async () => {
    const { loader } = toReactRouterHandlers(makeApp(), { prefix: "/api" });
    const outside = await loader({ request: new Request("http://localhost/other/items") });
    assert.equal(outside.status, 404);
    assert.equal((await outside.json()).error.code, "IL2001");
    assert.equal((await loader({ request: new Request("http://localhost/apix/items") })).status, 404);
    const bare = toReactRouterHandlers(makeApp());
    assert.deepEqual(await (await bare.loader({ request: new Request("http://localhost/items") })).json(), { items: [], q: null });
    const trailing = toReactRouterHandlers(makeApp(), { prefix: "/api/" });
    assert.equal((await trailing.loader({ request: new Request("http://localhost/api/items") })).status, 200);
  });

  test("invalid arguments and calls without a request raise IL5023", async () => {
    const fails = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL5023");
    fails(() => toReactRouterHandlers(undefined as never));
    fails(() => toReactRouterHandlers({} as never));
    fails(() => toReactRouterHandlers(makeApp(), { prefix: "api" }));
    fails(() => toReactRouterHandlers(makeApp(), { prefix: 1 as never }));
    fails(() => toReactRouterHandlers(makeApp(), null as never));
    const { loader } = toReactRouterHandlers(makeApp());
    await assert.rejects(loader(new Request("http://localhost/items") as never), (e: unknown) => e instanceof InferloError && e.code === "IL5023");
  });
});

test("@browserlessapi/inferlo/react-router is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./react-router"], { types: "./dist/react-router.d.ts", default: "./dist/react-router.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "react-router.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./errors.ts", "./serve.ts"]);
});
