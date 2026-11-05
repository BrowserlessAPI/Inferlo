import { getTestServer } from "@google-cloud/functions-framework/testing";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import "../src/index.ts";

const server = getTestServer("inferlo");
let base = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };

test("the function serves the app: OpenAPI, auth and validation", async () => {
  const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, { post?: unknown }> };
  assert.ok(doc.paths["/summaries"]?.post);
  assert.equal((await fetch(`${base}/status`)).status, 200);
  const anon = await fetch(`${base}/summaries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(anon.status, 401);
  // The Functions Framework reads the body before the function runs; the app still gets it.
  const invalid = await fetch(`${base}/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) });
  assert.equal(invalid.status, 422);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "IL1001");
});
