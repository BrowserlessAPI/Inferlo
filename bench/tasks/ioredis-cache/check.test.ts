import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

test("the cache is kept in Redis through the shared ioredis connection", () => {
  assert.equal(app.describe().cache, "redis");
  assert.equal(app.cache.store, "redis");
});
