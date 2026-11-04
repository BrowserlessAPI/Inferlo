import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route } from "../src/index.ts";
import { inferloAI, type InferloVariables } from "../src/hono.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeAI(reply = '{"label":"bug"}') {
  const usage: { for?: string; model: string }[] = [];
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
  return { ai, usage };
}

describe("inferloAI() middleware", () => {
  test("puts the AI client on c.var.ai, typed, with usage tracked per user", async () => {
    const { ai, usage } = makeAI();
    const hono = new Hono<{ Variables: InferloVariables }>();
    hono.use(inferloAI(ai));
    hono.post("/classify", async (c) => {
      const { text } = await c.req.json<{ text: string }>();
      const { object } = await c.var.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }), for: "user-1" });
      return c.json(object);
    });
    const res = await hono.request("/classify", { method: "POST", body: JSON.stringify({ text: "It crashes" }), headers: { "content-type": "application/json" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { label: "bug" });
    assert.equal(usage[0]?.for, "user-1");
  });

  test("streams AI text to the browser from a Hono route", async () => {
    const { ai } = makeAI("Hello from the model");
    const hono = new Hono<{ Variables: InferloVariables }>();
    hono.use("/chat/*", inferloAI(ai));
    hono.get("/chat/stream", (c) => c.var.ai.stream({ model: "fast", prompt: "hi" }).toResponse());
    const res = await hono.request("/chat/stream");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from the model");
  });

  test("works with an Inferlo app's app.ai", async () => {
    const inferlo = createApp({ ai: { providers: { mock: mockProvider({ respond: () => "pong" }) }, models: { fast: "mock:m" } }, logger: { info() {}, error() {} } });
    const hono = new Hono<{ Variables: InferloVariables }>().use(inferloAI(inferlo.ai));
    hono.get("/ping", async (c) => c.text((await c.var.ai.generate({ model: "fast", prompt: "ping" })).text));
    assert.equal(await (await hono.request("/ping")).text(), "pong");
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

describe("hono.mount() with a whole Inferlo app", () => {
  const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };
  const ping = route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }));
  const me = route.get("/me").handle(({ user }) => ({ id: user.id }));
  const create = route.post("/notes", { body: t.object({ title: t.string().min(1) }), tool: true }).handle(({ body, status }) => {
    status(201);
    return body;
  });
  const inferlo = createApp({ routes: [{ ping, me, create }], auth: bearer((token) => users[token] ?? null), logger: { info() {}, error() {} } });
  const hono = new Hono();
  hono.get("/", (c) => c.text("hono home"));
  hono.mount("/api", inferlo.fetch);

  test("routes, auth and validation work under the mount path", async () => {
    assert.equal(await (await hono.request("/")).text(), "hono home");
    assert.deepEqual(await (await hono.request("/api/ping")).json(), { pong: true });
    assert.equal((await hono.request("/api/me")).status, 401);
    assert.deepEqual(await (await hono.request("/api/me", { headers: { authorization: "Bearer alice" } })).json(), { id: "alice" });
    const bad = await hono.request("/api/notes", { method: "POST", body: "{}", headers: { authorization: "Bearer alice", "content-type": "application/json" } });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, "IL1001");
  });

  test("OpenAPI and MCP are served under the mount path", async () => {
    const doc = await (await hono.request("/api/openapi.json")).json();
    assert.ok(doc.paths["/notes"]);
    const mcp = await hono.request("/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer alice", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 200);
    assert.match(await mcp.text(), /create/);
  });
});

test("@browserlessapi/inferlo/hono is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./hono"], { types: "./dist/hono.d.ts", default: "./dist/hono.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const source = readFileSync(path.join(repo, "src/hono.ts"), "utf8");
  const runtimeImports = [...source.matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(runtimeImports, ["./ai-client.ts"]);
  const shared = readFileSync(path.join(repo, "src/ai-client.ts"), "utf8");
  assert.deepEqual([...shared.matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]), ["./errors.ts"]);
  assert.ok(existsSync(path.join(repo, "src/hono.ts")));
});
