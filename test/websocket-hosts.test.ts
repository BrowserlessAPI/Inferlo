// WebSocket routes on servers other frameworks create: toNodeUpgradeHandler on node:http, Express and Fastify
// servers, and Bun.serve({ fetch: app.fetch, websocket: bunWebSocket }) on Bun.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import Fastify from "fastify";
import { bunWebSocket, createApp, InferloError, route, t, toNodeHandler, toNodeUpgradeHandler } from "../src/index.ts";

const echo = route.ws("/echo", { auth: "public", message: t.object({ text: t.string() }) }).handle(({ message, url }) => ({ text: message.text, path: url.pathname }));
const hello = route.get("/hello", { auth: "public" }).handle(() => ({ hello: true }));
const makeApp = () => createApp({ routes: [{ echo, hello }], logger: { info() {}, error() {} } });

function roundTrip(url: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify(message));
    ws.onmessage = (event) => {
      resolve(JSON.parse(String(event.data)));
      ws.close();
    };
    ws.onerror = () => reject(new Error("connection refused"));
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}
const close = (server: http.Server) => new Promise<void>((resolve) => {
  server.close(() => resolve());
  server.closeAllConnections();
});

test("node:http: toNodeUpgradeHandler serves WebSocket routes next to the server's other upgrade listeners", async () => {
  const app = makeApp();
  const server = http.createServer(toNodeHandler(app, { prefix: "/api" }));
  server.on("upgrade", toNodeUpgradeHandler(app, { prefix: "/api" }));
  // Another library's upgrade listener, for paths outside the prefix.
  const others: string[] = [];
  server.on("upgrade", (req, socket) => {
    if (req.url?.startsWith("/api")) return;
    others.push(req.url ?? "");
    socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  const port = await listen(server);
  try {
    // The app sees the path without the prefix.
    assert.deepEqual(await roundTrip(`ws://127.0.0.1:${port}/api/echo`, { text: "hi" }), { text: "hi", path: "/echo" });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/hello`)).json(), { hello: true });
    await assert.rejects(() => roundTrip(`ws://127.0.0.1:${port}/socket.io/`, {}));
    assert.deepEqual(others, ["/socket.io/"], "upgrades outside the prefix are left to other listeners");
    // Inside the prefix, a path the app has no route for is answered by the app (404).
    await assert.rejects(() => roundTrip(`ws://127.0.0.1:${port}/api/missing`, {}));
  } finally {
    await app.close({ timeoutMs: 1000 });
    await close(server);
  }
});

test("fallthrough: true leaves upgrades the app has no route for to other listeners", async () => {
  const app = makeApp();
  const server = http.createServer();
  server.on("upgrade", toNodeUpgradeHandler(app, { fallthrough: true }));
  const others: string[] = [];
  server.on("upgrade", (req, socket) => {
    if (req.url === "/echo") return;
    others.push(req.url ?? "");
    socket.destroy();
  });
  const port = await listen(server);
  try {
    assert.deepEqual(await roundTrip(`ws://127.0.0.1:${port}/echo`, { text: "a" }), { text: "a", path: "/echo" });
    await assert.rejects(() => roundTrip(`ws://127.0.0.1:${port}/live-reload`, {}));
    assert.deepEqual(others, ["/live-reload"]);
  } finally {
    await app.close({ timeoutMs: 1000 });
    await close(server);
  }
});

test("Express: the server from app.listen() takes toNodeUpgradeHandler", async () => {
  const app = makeApp();
  const web = express();
  web.get("/health", (_req, res) => void res.json({ ok: true }));
  web.use("/api", toNodeHandler(app));
  const server = await new Promise<http.Server>((resolve) => {
    const s = web.listen(0, "127.0.0.1", () => resolve(s));
  });
  server.on("upgrade", toNodeUpgradeHandler(app, { prefix: "/api" }));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.deepEqual(await roundTrip(`ws://127.0.0.1:${port}/api/echo`, { text: "express" }), { text: "express", path: "/echo" });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ok: true });
  } finally {
    await app.close({ timeoutMs: 1000 });
    await close(server);
  }
});

test("Fastify: fastify.server takes toNodeUpgradeHandler", async () => {
  const app = makeApp();
  const fastify = Fastify();
  fastify.get("/health", async () => ({ ok: true }));
  fastify.server.on("upgrade", toNodeUpgradeHandler(app, { prefix: "/ws" }));
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const port = (fastify.server.address() as AddressInfo).port;
  try {
    assert.deepEqual(await roundTrip(`ws://127.0.0.1:${port}/ws/echo`, { text: "fastify" }), { text: "fastify", path: "/echo" });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { ok: true });
  } finally {
    await app.close({ timeoutMs: 1000 });
    await fastify.close();
  }
});

test("invalid toNodeUpgradeHandler options raise IL5019", () => {
  assert.throws(() => toNodeUpgradeHandler(makeApp(), { fallthrough: "yes" as never }), (e: InferloError) => e.code === "IL5019");
  assert.throws(() => toNodeUpgradeHandler({ fetch: async () => new Response() }, { fallthrough: true }), (e: InferloError) => e.code === "IL5019");
});

const Bun = (globalThis as { Bun?: { serve(options: object): { port: number; stop(force?: boolean): Promise<void> | void } } }).Bun;
test("Bun.serve({ fetch: app.fetch, websocket: bunWebSocket })", { skip: !Bun && "Bun only" }, async () => {
  const app = makeApp();
  const server = Bun!.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: bunWebSocket });
  try {
    assert.deepEqual(await roundTrip(`ws://127.0.0.1:${server.port}/echo`, { text: "bun" }), { text: "bun", path: "/echo" });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.port}/hello`)).json(), { hello: true });
  } finally {
    await app.close({ timeoutMs: 1000 });
    await server.stop(true);
  }
});

test("Bun.serve without bunWebSocket answers upgrades with 501 IL2011", { skip: !Bun && "Bun only" }, async () => {
  const app = makeApp();
  const server = Bun!.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  try {
    await assert.rejects(() => roundTrip(`ws://127.0.0.1:${server.port}/echo`, { text: "x" }));
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ port: server.port, host: "127.0.0.1", path: "/echo", headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
      req.on("response", (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(res.status, 501);
    assert.match(res.body, /IL2011/);
  } finally {
    await app.close({ timeoutMs: 1000 });
    await server.stop(true);
  }
});
