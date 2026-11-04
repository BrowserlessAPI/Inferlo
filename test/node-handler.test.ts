import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { bearer, createApp, fromNodeRequest, route, t, toNodeHandler } from "../src/index.ts";

const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };

const ping = route.get("/ping", { auth: "public" }).handle(({ query }) => ({ pong: true, query }));
const echo = route
  .post("/echo", { auth: "public", body: t.object({ text: t.string() }) })
  .handle(({ body, status }) => {
    status(201);
    return { text: body.text };
  });
const me = route.get("/me").handle(({ user }) => ({ id: user.id }));
const cookie = route.get("/cookie", { auth: "public" }).handle(({ header }) => {
  header("set-cookie", "a=1");
  return { ok: true };
});
const askTool = route.post("/ask", { auth: "public", body: t.object({ q: t.string() }), tool: true }).handle(({ body }) => ({ q: body.q }));

const app = createApp({
  name: "mounted",
  routes: [{ ping, echo, me, cookie, askTool }],
  auth: bearer((token) => users[token] ?? null),
  logger: { info() {}, error() {} },
});

type Host = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function start(host: Host): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(host);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((r) => server.close(() => r())) };
}

describe("toNodeHandler", () => {
  let base: { url: string; close(): Promise<void> };
  let unmatched = 0;
  const handler = toNodeHandler(app, { prefix: "/ai" });
  before(async () => {
    base = await start((req, res) =>
      handler(req, res, () => {
        unmatched++;
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("host app");
      }),
    );
  });
  after(() => base.close());

  test("strips the prefix and answers routes with query strings", async () => {
    const res = await fetch(`${base.url}/ai/ping?x=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pong: true, query: { x: "1" } });
  });

  test("streams request bodies and keeps status codes", async () => {
    const res = await fetch(`${base.url}/ai/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { text: "hi" });
  });

  test("auth, validation and errors behave as in app.fetch", async () => {
    assert.equal((await fetch(`${base.url}/ai/me`)).status, 401);
    const ok = await fetch(`${base.url}/ai/me`, { headers: { authorization: "Bearer alice" } });
    assert.deepEqual(await ok.json(), { id: "alice" });
    const bad = await fetch(`${base.url}/ai/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 422);
    assert.equal((await bad.json()).error.code, "IL1001");
  });

  test("serves OpenAPI and MCP under the prefix", async () => {
    const doc = await fetch(`${base.url}/ai/openapi.json`);
    assert.equal(doc.status, 200);
    assert.ok((await doc.json()).paths["/ping"]);
    const mcp = await fetch(`${base.url}/ai/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 200);
    assert.match(await mcp.text(), /askTool/);
  });

  test("the prefix itself maps to /, and set-cookie headers pass through", async () => {
    const res = await fetch(`${base.url}/ai/cookie`);
    assert.equal(res.headers.get("set-cookie"), "a=1");
    const root = await fetch(`${base.url}/ai`);
    assert.equal(root.status, 404);
    assert.equal((await root.json()).error.code, "IL2001");
  });

  test("requests outside the prefix go to next()", async () => {
    const before = unmatched;
    const res = await fetch(`${base.url}/other/ping`);
    assert.equal(await res.text(), "host app");
    const lookalike = await fetch(`${base.url}/aix/ping`);
    assert.equal(await lookalike.text(), "host app");
    assert.equal(unmatched, before + 2);
  });
});

describe("toNodeHandler without a prefix (frameworks that strip the mount path)", () => {
  test("uses req.url as it is and reads a body parsed by the host framework", async () => {
    const handler = toNodeHandler(app);
    const server = await start((req, res) => {
      // What express.json() does: read the stream and put the parsed value on req.body.
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        (req as { body?: unknown }).body = raw ? JSON.parse(raw) : {};
        // What app.use("/ai", ...) does: strip the mount path.
        req.url = req.url!.replace(/^\/ai/, "") || "/";
        void handler(req, res);
      });
    });
    try {
      const res = await fetch(`${server.url}/ai/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "parsed" }) });
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { text: "parsed" });
    } finally {
      await server.close();
    }
  });

  test("answers 404 itself when there is no next()", async () => {
    const server = await start((req, res) => void toNodeHandler(app, { prefix: "/ai" })(req, res));
    try {
      const res = await fetch(`${server.url}/elsewhere`);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).error.code, "IL2001");
    } finally {
      await server.close();
    }
  });
});

describe("fromNodeRequest", () => {
  test("builds a Web Request with method, URL, headers and body", async () => {
    let seen: Request | undefined;
    let text = "";
    const server = await start(async (req, res) => {
      seen = fromNodeRequest(req, { prefix: "/api" });
      text = await seen.text();
      res.end("ok");
    });
    try {
      await fetch(`${server.url}/api/items?a=1&a=2`, { method: "PUT", headers: { "x-one": "1", "content-type": "text/plain" }, body: "hello" });
      assert.equal(seen!.method, "PUT");
      const url = new URL(seen!.url);
      assert.equal(url.pathname, "/items");
      assert.deepEqual(url.searchParams.getAll("a"), ["1", "2"]);
      assert.equal(seen!.headers.get("x-one"), "1");
      assert.equal(text, "hello");
    } finally {
      await server.close();
    }
  });

  test("re-encodes a parsed object body as JSON and drops the stale content-length", async () => {
    const req = {
      method: "POST",
      url: "/echo",
      headers: { host: "example.com", "content-type": "application/x-www-form-urlencoded", "content-length": "6" },
      body: { text: "from form" },
      async *[Symbol.asyncIterator]() {},
    };
    const request = fromNodeRequest(req);
    assert.equal(request.url, "http://example.com/echo");
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(request.headers.get("content-length"), null);
    assert.deepEqual(await request.json(), { text: "from form" });
    const res = await app.fetch(fromNodeRequest(req));
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { text: "from form" });
  });

  test("keeps string and byte bodies as they are", async () => {
    const base = { method: "POST", url: "/x", headers: { host: "h", "content-type": "text/plain" }, async *[Symbol.asyncIterator]() {} };
    assert.equal(await fromNodeRequest({ ...base, body: "raw" }).text(), "raw");
    assert.equal(await fromNodeRequest({ ...base, body: new TextEncoder().encode("bytes") }).text(), "bytes");
    assert.equal(fromNodeRequest({ ...base, method: "GET", body: {} }).body, null);
  });

  test("uses https for encrypted sockets", () => {
    const req = { method: "GET", url: "/", headers: { host: "secure.test" }, socket: { encrypted: true }, async *[Symbol.asyncIterator]() {} };
    assert.equal(fromNodeRequest(req).url, "https://secure.test/");
  });
});
