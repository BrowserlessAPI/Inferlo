import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { app } from "../src/app.ts";

test("large answers are gzipped for clients that accept gzip, and small ones are not", async () => {
  const res = await app.fetch(new Request("http://localhost/openapi.json", { headers: { "accept-encoding": "gzip" } }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.match(res.headers.get("vary") ?? "", /accept-encoding/i);
  const doc = JSON.parse(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString("utf8"));
  assert.equal(doc.openapi.startsWith("3."), true);
  const plain = await app.fetch(new Request("http://localhost/openapi.json"));
  assert.equal(plain.headers.get("content-encoding"), null, "clients without Accept-Encoding get plain JSON");
  const small = await app.fetch(new Request("http://localhost/health", { headers: { "accept-encoding": "gzip" } }));
  assert.equal(small.headers.get("content-encoding"), null, "small answers are not compressed");
});
