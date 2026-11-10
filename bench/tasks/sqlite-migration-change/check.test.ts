import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { applyMigrations, createDb, planMigration } from "@browserlessapi/inferlo";
import { sqlite } from "@browserlessapi/inferlo/sqlite";
import { models } from "../src/models.ts";

test("color is required with the default gray", () => {
  const notes = models.find((m) => m.name === "notes")!;
  const color = (notes.fields as Record<string, { def: { optional?: boolean; defaultValue?: unknown } }>).color!;
  assert.notEqual(color.def.optional, true);
  assert.equal(color.def.defaultValue, "gray");
});

test("the snapshot matches the models and the migration fills existing notes with gray", async () => {
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.equal(snapshot.dialect, "sqlite", "the snapshot is still the SQLite one");
  assert.deepEqual(planMigration(models, snapshot, { dialect: "sqlite" }).statements, [], "migrations/snapshot.json does not match the models");
  const file = new URL("../migrations/0002_color_required.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_color_required.sql is missing");
  const db = createDb([], sqlite());
  try {
    await applyMigrations(db, [{ name: "0001_init", sql: readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8") }]);
    const now = new Date().toISOString();
    await db.$sql(`INSERT INTO "users" ("id", "created_at", "updated_at", "email", "name") VALUES ('u1', ?, ?, 'a@example.com', 'A')`, [now, now]);
    await db.$sql(`INSERT INTO "notes" ("id", "created_at", "updated_at", "title", "owner_id") VALUES ('n1', ?, ?, 'Plain', 'u1')`, [now, now]);
    await db.$sql(`INSERT INTO "notes" ("id", "created_at", "updated_at", "title", "owner_id", "color") VALUES ('n2', ?, ?, 'Red', 'u1', 'red')`, [now, now]);
    await applyMigrations(db, [{ name: "0002_color_required", sql: readFileSync(file, "utf8") }]);
    const rows = await db.$sql(`SELECT "id", "color" FROM "notes" ORDER BY "id"`);
    assert.deepEqual(rows.map((r) => [r.id, r.color]), [["n1", "gray"], ["n2", "red"]]);
    await assert.rejects(db.$sql(`INSERT INTO "notes" ("id", "created_at", "updated_at", "title", "owner_id", "color") VALUES ('n3', ?, ?, 'X', 'u1', NULL)`, [now, now]), "color is NOT NULL");
    const typed = createDb(models, db.$adapter);
    assert.deepEqual((await typed.$sync({ dryRun: true })).filter((s) => !/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(s)), []);
  } finally {
    await db.$close();
  }
});
