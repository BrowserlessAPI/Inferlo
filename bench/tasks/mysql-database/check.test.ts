import assert from "node:assert/strict";
import { test } from "node:test";

test("a mysql:// DATABASE_URL uses Inferlo's MySQL adapter", async () => {
  process.env.DATABASE_URL = "mysql://app:secret@127.0.0.1:1/app";
  const { app } = await import("../src/app.ts");
  assert.equal(app.db.$adapter.dialect, "mysql", "the app uses mysql() from @browserlessapi/inferlo/mysql");
  // The adapter connects on first use: port 1 refuses, so the error comes from MySQL's driver, not from pg.
  await assert.rejects(app.db.$sql("SELECT 1"), (error: Error) => !/pg\b|postgres/i.test(String(error.message)));
});
