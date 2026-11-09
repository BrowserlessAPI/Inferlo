import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJson } from "@browserlessapi/inferlo/testing";

test("with SQLITE_PATH the app keeps its data in that SQLite file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-sqlite-"));
  const path = join(dir, "app.db");
  process.env.SQLITE_PATH = path;
  delete process.env.DATABASE_URL;
  try {
    const { app } = await import("../src/app.ts");
    assert.equal(app.db.$adapter.dialect, "sqlite", "the app uses Inferlo's sqlite() adapter");
    await app.db.$sync();
    assert.ok(existsSync(path), "the database is the file at SQLITE_PATH");
    const db = app.db as any;
    const a = await db.users.insert({ email: "a@x.io", name: "A" });
    const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
    const note = await readJson(await app.request("/notes", { method: "POST", as: asA, json: { title: "Kept", body: "" } }), 201);
    const rows = await db.$sql('SELECT "title" FROM "notes" WHERE "id" = ?', [note.id]);
    assert.equal(rows[0].title, "Kept");
    await app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
