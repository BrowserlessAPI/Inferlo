import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Elysia } from "elysia";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route } from "../src/index.ts";
import { inferloAI } from "../src/elysia.ts";

const base = "http://localhost";

function makeAI(reply = '{"label":"bug"}') {
  const usage: { for?: string; model: string }[] = [];
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
  return { ai, usage };
}

describe("inferloAI() Elysia plugin", () => {
  test("decorates the context with ai, typed, with usage tracked per user", async () => {
    const { ai, usage } = makeAI();
    const app = new Elysia().use(inferloAI(ai)).post("/classify", async ({ ai, body }) => {
      const { text } = body as { text: string };
      const { object } = await ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }), for: "user-1" });
      return object;
    });
    const res = await app.handle(new Request(`${base}/classify`, { method: "POST", body: JSON.stringify({ text: "It crashes" }), headers: { "content-type": "application/json" } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { label: "bug" });
    assert.equal(usage[0]?.for, "user-1");
  });

  test("streams AI text to the browser from an Elysia route", async () => {
    const { ai } = makeAI("Hello from the model");
    const app = new Elysia().use(inferloAI(ai)).get("/chat", ({ ai }) => ai.stream({ model: "fast", prompt: "hi" }).toResponse());
    const res = await app.handle(new Request(`${base}/chat`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from the model");
  });

  test("works inside a prefixed Elysia group and with an Inferlo app's app.ai", async () => {
    const inferlo = createApp({ ai: { providers: { mock: mockProvider({ respond: () => "pong" }) }, models: { fast: "mock:m" } }, logger: { info() {}, error() {} } });
    const app = new Elysia({ prefix: "/v1" }).use(inferloAI(inferlo.ai)).get("/ping", async ({ ai }) => (await ai.generate({ model: "fast", prompt: "ping" })).text);
    assert.equal(await (await app.handle(new Request(`${base}/v1/ping`))).text(), "pong");
  });

  test("anything that is not an AI client raises IL5014", () => {
    for (const value of [undefined, {}, { generate() {} }, createApp({ logger: { info() {}, error() {} } })]) {
      assert.throws(
        () => inferloAI(value as never),
        (e: unknown) => e instanceof InferloError && e.code === "IL5014",
      );
    }
  });
});

describe("elysia.mount() with a whole Inferlo app", () => {
  const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };
  const ping = route.get("/ping", { auth: "public", query: t.object({ n: t.int().default(1) }) }).handle(({ query }) => ({ pong: query.n }));
  const me = route.get("/me").handle(({ user }) => ({ id: user.id }));
  const create = route.post("/notes", { body: t.object({ title: t.string().min(1) }), tool: true }).handle(({ body, status }) => {
    status(201);
    return body;
  });
  const inferlo = createApp({ routes: [{ ping, me, create }], auth: bearer((token) => users[token] ?? null), logger: { info() {}, error() {} } });
  const app = new Elysia().get("/", () => "elysia home").mount("/api", inferlo.fetch);
  const call = (path: string, init?: RequestInit) => app.handle(new Request(`${base}${path}`, init));

  test("routes, query strings, auth and validation work under the mount path", async () => {
    assert.equal(await (await call("/")).text(), "elysia home");
    assert.deepEqual(await (await call("/api/ping?n=3")).json(), { pong: 3 });
    assert.equal((await call("/api/me")).status, 401);
    assert.deepEqual(await (await call("/api/me", { headers: { authorization: "Bearer alice" } })).json(), { id: "alice" });
    const json = { "content-type": "application/json", authorization: "Bearer alice" };
    assert.equal((await call("/api/notes", { method: "POST", headers: json, body: JSON.stringify({ title: "" }) })).status, 422);
    const created = await call("/api/notes", { method: "POST", headers: json, body: JSON.stringify({ title: "Hi" }) });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { title: "Hi" });
  });

  test("OpenAPI and MCP are served under the mount path", async () => {
    const spec = await (await call("/api/openapi.json")).json();
    assert.ok(spec.paths["/notes"]);
    const res = await call("/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer alice" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 200);
    const names = (await res.json()).result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(names, ["create"]);
  });
});
