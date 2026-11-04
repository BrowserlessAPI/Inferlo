import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route, toNodeHandler } from "../src/index.ts";
import { inferloAI, sendResponse } from "../src/express.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, error() {} };

function makeAI(reply = '{"label":"bug"}') {
  const usage: { for?: string; model: string }[] = [];
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
  return { ai, usage };
}

async function listen(server: express.Express): Promise<{ base: string; close(): Promise<void> }> {
  const http = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const { port } = http.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

describe("inferloAI() Express middleware", () => {
  const { ai, usage } = makeAI();
  const stream = makeAI("Hello from the model").ai;
  const server = express();
  server.use(express.json());
  server.use(inferloAI(ai));
  server.post("/classify", async (req, res) => {
    // req.ai is typed: importing @browserlessapi/inferlo/express adds it to Express's Request.
    const { object } = await req.ai.generate({ model: "fast", prompt: String(req.body.text), output: t.object({ label: t.enum(["bug", "feature"]) }), for: "user-1" });
    res.json(object);
  });
  server.get("/chat", inferloAI(stream), (req, res) => sendResponse(res, req.ai.stream({ model: "fast", prompt: "hi" }).toResponse()));
  let running: Awaited<ReturnType<typeof listen>>;
  before(async () => void (running = await listen(server)));
  after(() => running.close());

  test("puts the AI client on req.ai, with usage tracked per user", async () => {
    const res = await fetch(`${running.base}/classify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "It crashes" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { label: "bug" });
    assert.equal(usage[0]?.for, "user-1");
  });

  test("sendResponse() streams an AI response as server-sent events", async () => {
    const res = await fetch(`${running.base}/chat`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = [...(await res.text()).matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
    assert.equal(text, "Hello from the model");
  });

  test("sendResponse() keeps the status and every Set-Cookie header", async () => {
    const app = express();
    app.get("/", (_req, res) => {
      const headers = new Headers({ "x-one": "1" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return sendResponse(res, new Response("created", { status: 201, headers }));
    });
    const r = await listen(app);
    try {
      const res = await fetch(r.base);
      assert.equal(res.status, 201);
      assert.equal(res.headers.get("x-one"), "1");
      assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
      assert.equal(await res.text(), "created");
    } finally {
      await r.close();
    }
  });

  test("works with an Inferlo app's app.ai", async () => {
    const inferlo = createApp({ ai: { providers: { mock: mockProvider({ respond: () => "pong" }) }, models: { fast: "mock:m" } }, logger: quiet });
    const app = express();
    app.use(inferloAI(inferlo.ai));
    app.get("/ping", async (req, res) => void res.send((await req.ai.generate({ model: "fast", prompt: "ping" })).text));
    const r = await listen(app);
    try {
      assert.equal(await (await fetch(`${r.base}/ping`)).text(), "pong");
    } finally {
      await r.close();
    }
  });

  test("anything that is not an AI client raises IL5014", () => {
    for (const value of [undefined, {}, { generate() {} }, createApp({ logger: quiet })]) {
      assert.throws(
        () => inferloAI(value as never),
        (e: unknown) => e instanceof InferloError && e.code === "IL5014" && Boolean(e.fix?.includes("server.use(inferloAI(ai))")),
      );
    }
  });
});

describe("a whole Inferlo app mounted in Express with toNodeHandler", () => {
  const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };
  const ping = route.get("/ping", { auth: "public" }).handle(() => ({ pong: true }));
  const me = route.get("/me").handle(({ user }) => ({ id: user.id }));
  const create = route.post("/notes", { body: t.object({ title: t.string().min(1) }), tool: true }).handle(({ body, status }) => {
    status(201);
    return body;
  });
  const inferlo = createApp({ routes: [{ ping, me, create }], auth: bearer((token) => users[token] ?? null), logger: quiet });
  const server = express();
  server.use(express.json()); // the parsed body is passed on to Inferlo
  server.get("/", (_req, res) => void res.send("express home"));
  server.use("/api", toNodeHandler(inferlo));
  server.get("/after", (_req, res) => void res.send("still express"));
  let running: Awaited<ReturnType<typeof listen>>;
  before(async () => void (running = await listen(server)));
  after(() => running.close());

  test("routes, auth and validation work under the mount path", async () => {
    assert.equal(await (await fetch(`${running.base}/`)).text(), "express home");
    assert.deepEqual(await (await fetch(`${running.base}/api/ping`)).json(), { pong: true });
    assert.equal((await fetch(`${running.base}/api/me`)).status, 401);
    assert.deepEqual(await (await fetch(`${running.base}/api/me`, { headers: { authorization: "Bearer alice" } })).json(), { id: "alice" });
    const headers = { authorization: "Bearer alice", "content-type": "application/json" };
    const bad = await fetch(`${running.base}/api/notes`, { method: "POST", headers, body: "{}" });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, "IL1001");
    const good = await fetch(`${running.base}/api/notes`, { method: "POST", headers, body: JSON.stringify({ title: "Hi" }) });
    assert.equal(good.status, 201);
    assert.deepEqual(await good.json(), { title: "Hi" });
  });

  test("OpenAPI and MCP are served under the mount path", async () => {
    const doc = await (await fetch(`${running.base}/api/openapi.json`)).json();
    assert.ok(doc.paths["/notes"]);
    const mcp = await fetch(`${running.base}/api/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer alice", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 200);
    assert.match(await mcp.text(), /create/);
  });
});

test("@browserlessapi/inferlo/express is exported and loads no router, database or jobs code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./express"], { types: "./dist/express.d.ts", default: "./dist/express.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = (file: string) => [...readFileSync(path.join(repo, "src", file), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports("express.ts"), ["./ai-client.ts", "./serve.ts"]);
  assert.deepEqual(imports("serve.ts"), ["./client-ip.ts"]);
});
