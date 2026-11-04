import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

test("logs are JSON lines with every request logged", () => {
  assert.deepEqual(app.describe().logging, { format: "json", requests: true });
});

test("GET /debug/request is public and returns the id from the X-Request-Id header", async () => {
  const original = console.log;
  console.log = () => {};
  try {
    const res = await app.request("/debug/request");
    assert.equal(res.status, 200);
    const id = res.headers.get("x-request-id");
    assert.ok(id);
    assert.deepEqual(await res.json(), { requestId: id });
  } finally {
    console.log = original;
  }
});
