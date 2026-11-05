import { getTestServer } from "@google-cloud/functions-framework/testing";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import "../src/index.ts";

test("the Cloud Run function named inferlo serves the Inferlo app", async () => {
  const server = getTestServer("inferlo");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as { paths: Record<string, unknown> };
    assert.ok(doc.paths["/notes"], "OpenAPI of the app");
    const post = await fetch(`${base}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    assert.equal(post.status, 401, "POST /notes needs sign-in");
    assert.equal(((await post.json()) as { error: { code: string } }).error.code, "IL3001");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
