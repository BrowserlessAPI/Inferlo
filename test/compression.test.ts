import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { describe, test } from "node:test";
import { gunzipSync, inflateSync } from "node:zlib";
import { createApp, InferloError, route, t } from "../src/index.ts";
import { toNodeHandler } from "../src/serve.ts";
import { createServer } from "node:http";
import { chooseEncoding } from "../src/compression.ts";

const logger = { info() {}, error() {} };
const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Note number ${i}` })) };

const routes = [
  route.get("/big", { auth: "public" }).handle(() => big),
  route.get("/small", { auth: "public" }).handle(() => ({ ok: true })),
  route.get("/text", { auth: "public" }).handle(() => new Response("x".repeat(5000), { headers: { "content-type": "text/plain; charset=utf-8" } })),
  route.get("/png", { auth: "public" }).handle(() => new Response(new Uint8Array(5000), { headers: { "content-type": "image/png" } })),
  route.get("/events", { auth: "public" }).handle(() => new Response("data: hi\n\n".repeat(500), { headers: { "content-type": "text/event-stream" } })),
  route.get("/no-transform", { auth: "public" }).handle(() => new Response(JSON.stringify(big), { headers: { "content-type": "application/json", "cache-control": "no-transform" } })),
  route.get("/encoded", { auth: "public" }).handle(() => new Response("abc".repeat(1000), { headers: { "content-type": "text/plain", "content-encoding": "identity-test" } })),
  route.get("/etag", { auth: "public" }).handle(() => new Response(JSON.stringify(big), { headers: { "content-type": "application/json", etag: '"v1"', vary: "Origin" } })),
  route.get("/empty", { auth: "public" }).handle(() => new Response(null, { status: 204 })),
  route.get("/cached", { auth: "public", cache: { ttlMs: 60_000, by: "public" } }).handle(() => big),
  route.post("/echo", { auth: "public", body: t.object({ text: t.string() }) }).handle(({ body }) => ({ text: body.text.repeat(500) })),
];

function get(app: { fetch(req: Request): Promise<Response> }, path: string, headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br" }, method = "GET") {
  return app.fetch(new Request(`http://localhost${path}`, { method, headers }));
}

describe("createApp({ compression })", () => {
  test("large JSON answers are gzipped when the client accepts gzip", async () => {
    const app = createApp({ routes, compression: true, logger });
    const res = await get(app, "/big");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), "gzip");
    assert.equal(res.headers.get("vary"), "Accept-Encoding");
    assert.equal(res.headers.get("content-length"), null);
    assert.ok(res.headers.get("x-request-id"), "Inferlo's headers are kept");
    assert.ok(res.headers.get("x-content-type-options"), "secure headers are kept");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.byteLength < JSON.stringify(big).length / 3, "smaller than the JSON");
    assert.deepEqual(JSON.parse(gunzipSync(bytes).toString("utf8")), big);
  });

  test("deflate is used when the client accepts only deflate, and the configured order is the preference", async () => {
    const app = createApp({ routes, compression: true, logger });
    const res = await get(app, "/big", { "accept-encoding": "deflate" });
    assert.equal(res.headers.get("content-encoding"), "deflate");
    assert.deepEqual(JSON.parse(inflateSync(new Uint8Array(await res.arrayBuffer())).toString("utf8")), big);
    const preferDeflate = createApp({ routes, compression: { encodings: ["deflate", "gzip"] }, logger });
    assert.equal((await get(preferDeflate, "/big", { "accept-encoding": "gzip, deflate" })).headers.get("content-encoding"), "deflate");
  });

  test("no Accept-Encoding, identity only or q=0 answers uncompressed with Vary", async () => {
    const app = createApp({ routes, compression: true, logger });
    for (const accept of [undefined, "identity", "gzip;q=0, deflate;q=0", "br"]) {
      const res = await get(app, "/big", accept === undefined ? {} : { "accept-encoding": accept });
      assert.equal(res.headers.get("content-encoding"), null, String(accept));
      assert.equal(res.headers.get("vary"), "Accept-Encoding", String(accept));
      assert.deepEqual(await res.json(), big);
    }
  });

  test("answers below the threshold, images, Server-Sent Events, no-transform, encoded and empty answers are left alone", async () => {
    const app = createApp({ routes, compression: true, logger });
    for (const path of ["/small", "/png", "/events", "/no-transform", "/encoded", "/empty"]) {
      const res = await get(app, path);
      assert.notEqual(res.headers.get("content-encoding"), "gzip", path);
    }
    assert.equal((await get(app, "/small")).headers.get("vary"), null, "too small to vary");
    assert.equal((await get(app, "/events")).headers.get("content-type"), "text/event-stream");
    const zero = createApp({ routes, compression: { threshold: 0 }, logger });
    assert.equal((await get(zero, "/small")).headers.get("content-encoding"), "gzip");
  });

  test("text answers from handlers are compressed, strong ETags become weak and Vary is extended", async () => {
    const app = createApp({ routes, compression: true, logger });
    const text = await get(app, "/text");
    assert.equal(text.headers.get("content-encoding"), "gzip");
    assert.equal(gunzipSync(new Uint8Array(await text.arrayBuffer())).toString("utf8"), "x".repeat(5000));
    const res = await get(app, "/etag");
    assert.equal(res.headers.get("etag"), 'W/"v1"');
    assert.equal(res.headers.get("vary"), "Origin, Accept-Encoding");
  });

  test("HEAD requests are not compressed", async () => {
    const app = createApp({ routes, compression: true, logger });
    const res = await get(app, "/big", { "accept-encoding": "gzip" }, "HEAD");
    assert.equal(res.headers.get("content-encoding"), null);
  });

  test("cached routes keep ETags and 304 answers", async () => {
    const app = createApp({ routes, compression: true, logger });
    const first = await get(app, "/cached");
    assert.equal(first.headers.get("content-encoding"), "gzip");
    const etag = first.headers.get("etag")!;
    assert.match(etag, /^W\//);
    const second = await get(app, "/cached", { "accept-encoding": "gzip", "if-none-match": etag });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("content-encoding"), null);
  });

  test("off by default", async () => {
    const app = createApp({ routes, logger });
    const res = await get(app, "/big");
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal(app.describe().compression, false);
  });

  test("describe() shows the setup", () => {
    assert.deepEqual(createApp({ routes, compression: true, logger }).describe().compression, { threshold: 1024, encodings: ["gzip", "deflate"] });
    assert.deepEqual(createApp({ routes, compression: { threshold: 2048, encodings: ["gzip"] }, logger }).describe().compression, { threshold: 2048, encodings: ["gzip"] });
  });

  test("invalid options raise IL6063", () => {
    for (const compression of ["gzip", null, [], { level: 9 }, { threshold: -1 }, { threshold: 1.5 }, { encodings: [] }, { encodings: ["br"] }, { encodings: ["gzip", "gzip"] }]) {
      assert.throws(() => createApp({ routes, compression: compression as never, logger }), (error: unknown) => error instanceof InferloError && error.code === "IL6063" && /compression/.test(error.fix ?? ""), JSON.stringify(compression));
    }
  });

  test("chooseEncoding follows q values and *", () => {
    assert.equal(chooseEncoding("gzip;q=0.5, deflate", ["gzip", "deflate"]), "gzip");
    assert.equal(chooseEncoding("*", ["gzip", "deflate"]), "gzip");
    assert.equal(chooseEncoding("*;q=0", ["gzip"]), undefined);
    assert.equal(chooseEncoding("GZIP", ["gzip"]), "gzip");
    assert.equal(chooseEncoding("deflate;q=0, *", ["deflate", "gzip"]), "gzip");
    assert.equal(chooseEncoding(null, ["gzip"]), undefined);
  });

  test("Node.js servers send the compressed bytes", async () => {
    const app = createApp({ routes, compression: true, logger });
    const server = createServer(toNodeHandler(app));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const { headers, body } = await new Promise<{ headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/echo", method: "POST", headers: { "accept-encoding": "gzip", "content-type": "application/json", connection: "close" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end(JSON.stringify({ text: "hello " }));
      });
      assert.equal(headers["content-encoding"], "gzip");
      assert.deepEqual(JSON.parse(gunzipSync(body).toString("utf8")), { text: "hello ".repeat(500) });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
