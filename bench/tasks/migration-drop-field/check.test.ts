import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, planMigration } from "@browserlessapi/kairo";
import { readJson } from "@browserlessapi/kairo/testing";
import { models, Note } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("color is gone from notes and notes still work", async () => {
  assert.ok(!("color" in Note.fields), "notes still has a color field");
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const u = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const user = { id: u.id, email: u.email, name: u.name, roles: [] };
  const note = await readJson(await app.request("/notes", { method: "POST", json: { title: "a" }, as: user }), 201);
  assert.equal(note.title, "a");
  assert.equal("color" in note, false);
});

test("migration file and snapshot match the models", () => {
  const file = new URL("../migrations/0002_drop_color.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_drop_color.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  for (const statement of ['DROP INDEX IF EXISTS "notes_color_idx"', 'ALTER TABLE "notes" DROP COLUMN IF EXISTS "color"']) {
    assert.ok(sql.includes(normalize(statement)), `migration is missing: ${statement}\ngot: ${sql}`);
  }
});
