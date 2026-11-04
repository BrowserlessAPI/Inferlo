import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";
import { storage } from "../src/storage.ts";

test("GET /health and GET /ready use the built-in health endpoints with a storage check", async () => {
  const live = await app.request("/health");
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "ok" });
  assert.equal(app.describe().endpoints.ready, "/ready");

  storage.reachable = true;
  const ready = await app.request("/ready");
  assert.equal(ready.status, 200);
  const body = await ready.json();
  assert.equal(body.status, "ready");
  assert.equal(body.checks.storage.status, "ok");
  assert.equal(body.checks.database.status, "ok");

  storage.reachable = false;
  const down = await app.request("/ready");
  assert.equal(down.status, 503);
  const failed = await down.json();
  assert.equal(failed.checks.storage.status, "error");
  assert.equal(failed.checks.database.status, "ok");
  assert.equal((await app.request("/health")).status, 200, "liveness does not depend on storage");
  storage.reachable = true;
});
