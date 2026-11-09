import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the app always uses SQLite at SQLITE_PATH, data/app.db by default", async () => {
  delete process.env.SQLITE_PATH;
  process.env.DATABASE_URL = "postgres://ignored:ignored@127.0.0.1:1/ignored";
  const root = new URL("../", import.meta.url);
  assert.ok(existsSync(new URL("data/.gitkeep", root)), "data/.gitkeep keeps the data folder");
  const config = readFileSync(new URL("src/config.ts", root), "utf8");
  assert.doesNotMatch(config, /DATABASE_URL/, "the DATABASE_URL setting is removed");
  process.chdir(fileURLToPath(root));
  const { app } = await import("../src/app.ts");
  assert.equal(app.db.$adapter.dialect, "sqlite", "the app uses Inferlo's sqlite() adapter even with DATABASE_URL set");
  await app.db.$sync();
  assert.ok(existsSync(new URL("data/app.db", root)), "the default file is data/app.db");
  const user = await (app.db as any).users.insert({ email: "a@x.io", name: "A" });
  assert.equal(user.email, "a@x.io");
  await app.db.$close();
  rmSync(new URL("data/app.db", root), { force: true });
});
