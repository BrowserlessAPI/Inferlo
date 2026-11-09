import assert from "node:assert/strict";
import { test } from "node:test";

test("with a mysql:// DATABASE_URL, jobs, cache and rate limits are kept in MySQL", async () => {
  // Settings are read once, so DATABASE_URL is set before the app is imported.
  process.env.DATABASE_URL = "mysql://app:secret@127.0.0.1:1/app";
  const { app } = await import("../src/app.ts");
  assert.equal(app.db.$adapter.dialect, "mysql", "the app uses mysql() from @browserlessapi/inferlo/mysql");
  const map = app.describe();
  assert.equal(map.jobQueue, "database", 'createApp({ jobQueue: { store: "database" } })');
  assert.equal(map.cache, "database", 'createApp({ cache: { store: "database" } })');
  // Nothing listens on port 1: a database-backed cache must fail, an in-memory one would not.
  await assert.rejects(app.cache.get("probe"), "the cache must read from MySQL");
  await app.db.$close();
});
