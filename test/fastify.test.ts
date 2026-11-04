import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route } from "../src/index.ts";
import { inferloPlugin } from "../src/fastify.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, error() {} };

function makeAI(reply = '{"label":"bug"}') {
  const usage: { for?: string }[] = [];
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
  return { ai, usage };
}

const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };
const ping = route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }));
const me = route.get("/me").handle(({ user }) => ({ id: user.id }));
const create = route.post("/notes", { body: t.object({ title: t.string().min(1) }), tool: true }).handle(({ body, status }) => {
  status(201);
  return body;
});
const form = route.post("/form", { auth: "public", body: t.object({ name: t.string() }) }).handle(({ body }) => body);
const makeInferlo = (ai?: ReturnType<typeof makeAI>["ai"]) =>
  createApp({ routes: [{ ping, me, create, form }], auth: bearer((token) => users[token] ?? null), logger: quiet, maxBodySize: 1000, ...(ai ? { ai: { providers: { mock: mockProvider({ respond: () => "from app" }) }, models: { fast: "mock:m" } } } : {}) });

describe("inferloPlugin with { ai }", () => {
  test("decorates fastify.ai and request.ai for the whole Fastify app", async () => {
    const { ai, usage } = makeAI();
    const fastify = Fastify();
    await fastify.register(inferloPlugin, { ai });
    fastify.post("/classify", async (request) => {
      const { text } = request.body as { text: string };
      const { object } = await request.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }), for: "user-1" });
      return object;
    });
    await fastify.register(async (child) => {
      child.get("/nested", async () => ({ same: child.ai === ai }));
    });
    const res = await fastify.inject({ method: "POST", url: "/classify", payload: { text: "It crashes" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { label: "bug" });
    assert.equal(usage[0]?.for, "user-1");
    assert.equal(fastify.ai, ai);
    assert.deepEqual((await fastify.inject("/nested")).json(), { same: true });
    await fastify.close();
  });

  test("streams AI text with reply.send(response)", async () => {
    const { ai } = makeAI("Hello from the model");
    const fastify = Fastify();
    await fastify.register(inferloPlugin, { ai });
    fastify.get("/chat", (request, reply) => reply.send(request.ai.stream({ model: "fast", prompt: "hi" }).toResponse()));
    const res = await fastify.inject("/chat");
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    const text = [...res.body.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from the model");
    await fastify.close();
  });
});

describe("inferloPlugin with { app, prefix }", () => {
  const start = async () => {
    const fastify = Fastify();
    fastify.get("/", async () => "fastify home");
    await fastify.register(inferloPlugin, { app: makeInferlo(makeAI().ai), prefix: "/api" });
    fastify.get("/after", async () => "still fastify");
    return fastify;
  };

  test("serves routes, auth and validation under the prefix, next to Fastify routes", async () => {
    const fastify = await start();
    assert.equal((await fastify.inject("/")).body, "fastify home");
    assert.equal((await fastify.inject("/after")).body, "still fastify");
    assert.deepEqual((await fastify.inject("/api/ping")).json(), { pong: true });
    assert.equal((await fastify.inject("/api/me")).statusCode, 401);
    assert.deepEqual((await fastify.inject({ url: "/api/me", headers: { authorization: "Bearer alice" } })).json(), { id: "alice" });
    const bad = await fastify.inject({ method: "POST", url: "/api/notes", headers: { authorization: "Bearer alice" }, payload: {} });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, "IL1001");
    const good = await fastify.inject({ method: "POST", url: "/api/notes", headers: { authorization: "Bearer alice" }, payload: { title: "Hi" } });
    assert.equal(good.statusCode, 201);
    assert.deepEqual(good.json(), { title: "Hi" });
    const missing = await fastify.inject("/api/nope");
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, "IL2001");
    await fastify.close();
  });

  test("Inferlo reads the body itself: forms, invalid JSON and its own size limit", async () => {
    const fastify = await start();
    const formRes = await fastify.inject({ method: "POST", url: "/api/form", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "name=Ada" });
    assert.equal(formRes.statusCode, 200);
    assert.deepEqual(formRes.json(), { name: "Ada" });
    const invalid = await fastify.inject({ method: "POST", url: "/api/form", headers: { "content-type": "application/json" }, payload: "{nope" });
    assert.equal(invalid.json().error.code, "IL2003");
    const big = await fastify.inject({ method: "POST", url: "/api/form", headers: { "content-type": "application/json" }, payload: JSON.stringify({ name: "x".repeat(2000) }) });
    assert.equal(big.statusCode, 413);
    assert.equal(big.json().error.code, "IL2004");
    await fastify.close();
  });

  test("OpenAPI, MCP and the app's AI are available", async () => {
    const fastify = await start();
    assert.ok((await fastify.inject("/api/openapi.json")).json().paths["/notes"]);
    const mcp = await fastify.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { authorization: "Bearer alice", "content-type": "application/json", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assert.equal(mcp.statusCode, 200);
    assert.match(mcp.body, /create/);
    assert.equal((await fastify.ai.generate({ model: "fast", prompt: "x" })).text, "from app", "fastify.ai defaults to app.ai");
    await fastify.close();
  });

  test("{ ai } and { app, prefix } can be registered one after the other", async () => {
    const { ai } = makeAI();
    const fastify = Fastify();
    await fastify.register(inferloPlugin, { ai });
    await fastify.register(inferloPlugin, { app: makeInferlo(makeAI().ai), prefix: "/api" });
    assert.equal(fastify.ai, ai, "the explicit ai is kept");
    assert.deepEqual((await fastify.inject("/api/ping")).json(), { pong: true });
    await fastify.close();
  });

  test("works over a real socket", async () => {
    const fastify = await start();
    const address = await fastify.listen({ port: 0, host: "127.0.0.1" });
    try {
      const res = await fetch(`${address}/api/ping`);
      assert.deepEqual(await res.json(), { pong: true });
    } finally {
      await fastify.close();
    }
  });
});

test("invalid options raise IL5014 or IL5015", async () => {
  const cases: [unknown, string][] = [
    [{}, "IL5015"],
    [{ ai: {} }, "IL5014"],
    [{ app: {} }, "IL5015"],
    [{ app: makeInferlo() }, "IL5015"],
    [{ app: makeInferlo(), prefix: "api" }, "IL5015"],
    [{ app: makeInferlo(), prefix: "/api/" }, "IL5015"],
  ];
  for (const [options, code] of cases) {
    const fastify = Fastify();
    await assert.rejects(
      async () => {
        await fastify.register(inferloPlugin, options as never);
        await fastify.ready();
      },
      (e: unknown) => e instanceof InferloError && e.code === code,
      JSON.stringify(Object.keys(options as object)),
    );
  }
});

test("@browserlessapi/inferlo/fastify is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./fastify"], { types: "./dist/fastify.d.ts", default: "./dist/fastify.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src/fastify.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./ai-client.ts", "./errors.ts", "./serve.ts"]);
});
