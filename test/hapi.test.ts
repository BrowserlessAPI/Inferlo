import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import Hapi from "@hapi/hapi";
import { createAI, mockProvider } from "../src/ai/public.ts";
import { inferloPlugin } from "../src/hapi.ts";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";

const users = new Map([["demo", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);
const ai = () => ({ providers: { mock: mockProvider({ respond: () => "Hello from AI." }) }, models: { fast: "mock:m" } });

function makeApp() {
  const routes = {
    listItems: route.get("/items", { auth: "public", query: t.object({ q: t.string().optional() }) }).handle(({ query }) => ({ items: [], q: query.q ?? null })),
    createItem: route.post("/items", { body: t.object({ name: t.string().min(1) }) }).handle(({ body, user, status, header }) => {
      status(201);
      header("set-cookie", "a=1; Path=/");
      header("set-cookie", "b=2; Path=/");
      return { name: body.name, ownerId: user.id };
    }),
    root: route.get("/", { auth: "public" }).handle(() => ({ root: true })),
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse()),
  };
  return createApp({ name: "hapi-test", routes: [routes], auth: bearer((token) => users.get(token) ?? null), ai: ai() });
}

const code = (expected: string) => (e: unknown) => e instanceof InferloError && e.code === expected;
const json = { "content-type": "application/json" };

/**
 * A request over a real connection (the server is started on first use). hapi's server.inject is not used:
 * it gives empty answers on Bun 1.3.0, and a real connection is what apps get.
 */
async function call(server: Hapi.Server, path: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  if (!server.info.started) await server.start();
  const res = await fetch(`${server.info.uri}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

describe("hapi inferloPlugin", () => {
  const servers: Hapi.Server[] = [];
  after(async () => {
    for (const server of servers) await server.stop();
  });
  const server = () => {
    const s = Hapi.server({ port: 0, host: "127.0.0.1" });
    servers.push(s);
    return s;
  };

  test("{ ai } decorates server.ai and request.ai", async () => {
    const s = server();
    const client = createAI(ai());
    await s.register({ plugin: inferloPlugin, options: { ai: client } });
    assert.equal(s.ai, client);
    s.route({ method: "GET", path: "/hello", handler: async (request) => ({ text: (await request.ai.generate({ model: "fast", prompt: "hi" })).text, same: request.ai === client }) });
    const res = await call(s, "/hello");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { text: "Hello from AI.", same: true });
  });

  test("{ app } with routes.prefix serves the whole app under the prefix next to hapi's routes", async () => {
    const s = server();
    await s.register({ plugin: inferloPlugin, options: { app: makeApp() }, routes: { prefix: "/api" } });
    s.route({ method: "GET", path: "/hapi", handler: () => ({ hapi: true }) });
    assert.ok(s.ai, "server.ai defaults to the app's AI client");
    const list = await call(s, "/api/items?q=lamp");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, { items: [], q: "lamp" });
    assert.deepEqual((await call(s, "/api")).body, { root: true });
    assert.ok((await call(s, "/api/openapi.json")).body.paths["/items"]);
    assert.deepEqual((await call(s, "/hapi")).body, { hapi: true });
    assert.equal((await call(s, "/elsewhere")).status, 404, "hapi answers outside the prefix");

    const anon = await call(s, "/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "x" }) });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, "IL3001");
    const signedIn = { ...json, authorization: "Bearer demo" };
    const created = await call(s, "/api/items", { method: "POST", headers: signedIn, body: JSON.stringify({ name: "Lamp" }) });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
    assert.deepEqual(created.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
    const invalid = await call(s, "/api/items", { method: "POST", headers: signedIn, body: JSON.stringify({ name: "" }) });
    assert.equal(invalid.status, 422);
  });

  test("without a prefix the app answers every path hapi has no route for", async () => {
    const s = server();
    s.route({ method: "GET", path: "/items", handler: () => ({ fromHapi: true }) });
    await s.register({ plugin: inferloPlugin, options: { app: makeApp() } });
    assert.deepEqual((await call(s, "/items")).body, { fromHapi: true }, "hapi's own route is more specific");
    assert.deepEqual((await call(s, "/")).body, { root: true });
    assert.equal((await call(s, "/items", { method: "POST", headers: json, body: JSON.stringify({ name: "x" }) })).status, 401, "other methods reach the app");
  });

  test("streams AI answers over a real connection", async () => {
    const s = server();
    await s.register({ plugin: inferloPlugin, options: { app: makeApp() }, routes: { prefix: "/api" } });
    await s.start();
    const res = await fetch(`${s.info.uri}/api/chat`);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from AI.");
    const post = await fetch(`${s.info.uri}/api/items`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer demo" }, body: JSON.stringify({ name: "Desk" }) });
    assert.equal(post.status, 201);
  });

  test("{ ai } and { app } can be registered together", async () => {
    const s = server();
    const client = createAI(ai());
    await s.register({ plugin: inferloPlugin, options: { ai: client } });
    await s.register({ plugin: inferloPlugin, options: { app: makeApp() }, routes: { prefix: "/api" } });
    assert.equal(s.ai, client, "the earlier { ai } stays");
    assert.equal((await call(s, "/api/items")).status, 200);
  });

  test("invalid options raise IL5025", async () => {
    await assert.rejects(server().register({ plugin: inferloPlugin, options: {} }), code("IL5025"));
    await assert.rejects(server().register({ plugin: inferloPlugin, options: { app: {} as never } }), code("IL5025"));
    await assert.rejects(server().register({ plugin: inferloPlugin, options: { app: makeApp(), prefix: "/api" } as never }), code("IL5025"));
    await assert.rejects(server().register({ plugin: inferloPlugin, options: { ai: {} as never } }), code("IL5014"));
    const s = server();
    await s.register({ plugin: inferloPlugin, options: { ai: createAI(ai()) } });
    await assert.rejects(s.register({ plugin: inferloPlugin, options: { ai: createAI(ai()) } }), code("IL5025"));
  });
});
