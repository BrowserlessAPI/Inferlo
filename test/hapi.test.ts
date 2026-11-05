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
    const res = await s.inject("/hello");
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.payload), { text: "Hello from AI.", same: true });
  });

  test("{ app } with routes.prefix serves the whole app under the prefix next to hapi's routes", async () => {
    const s = server();
    await s.register({ plugin: inferloPlugin, options: { app: makeApp() }, routes: { prefix: "/api" } });
    s.route({ method: "GET", path: "/hapi", handler: () => ({ hapi: true }) });
    assert.ok(s.ai, "server.ai defaults to the app's AI client");
    const list = await s.inject("/api/items?q=lamp");
    assert.equal(list.statusCode, 200);
    assert.deepEqual(JSON.parse(list.payload), { items: [], q: "lamp" });
    assert.deepEqual(JSON.parse((await s.inject("/api")).payload), { root: true });
    assert.ok(JSON.parse((await s.inject("/api/openapi.json")).payload).paths["/items"]);
    assert.deepEqual(JSON.parse((await s.inject("/hapi")).payload), { hapi: true });
    assert.equal((await s.inject("/elsewhere")).statusCode, 404, "hapi answers outside the prefix");

    const anon = await s.inject({ method: "POST", url: "/api/items", payload: { name: "x" } });
    assert.equal(anon.statusCode, 401);
    assert.equal(JSON.parse(anon.payload).error.code, "IL3001");
    const created = await s.inject({ method: "POST", url: "/api/items", payload: { name: "Lamp" }, headers: { authorization: "Bearer demo" } });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(JSON.parse(created.payload), { name: "Lamp", ownerId: "00000000-0000-4000-8000-000000000001" });
    assert.deepEqual(created.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
    const invalid = await s.inject({ method: "POST", url: "/api/items", payload: { name: "" }, headers: { authorization: "Bearer demo" } });
    assert.equal(invalid.statusCode, 422);
  });

  test("without a prefix the app answers every path hapi has no route for", async () => {
    const s = server();
    s.route({ method: "GET", path: "/items", handler: () => ({ fromHapi: true }) });
    await s.register({ plugin: inferloPlugin, options: { app: makeApp() } });
    assert.deepEqual(JSON.parse((await s.inject("/items")).payload), { fromHapi: true }, "hapi's own route is more specific");
    assert.deepEqual(JSON.parse((await s.inject("/")).payload), { root: true });
    assert.equal((await s.inject({ method: "POST", url: "/items", payload: { name: "x" } })).statusCode, 401, "other methods reach the app");
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
    assert.equal((await s.inject("/api/items")).statusCode, 200);
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
