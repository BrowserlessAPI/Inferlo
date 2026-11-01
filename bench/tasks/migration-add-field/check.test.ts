import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, planMigration } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("archived field can be set on update", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const u = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const user = { id: u.id, email: u.email, name: u.name, roles: [] };
  const note = await readJson(await app.request("/notes", { method: "POST", json: { title: "a" }, as: user }), 201);
  assert.equal(note.archived, false);
  const upd = await readJson(await app.request(`/notes/${note.id}`, { method: "PATCH", json: { archived: true }, as: user }), 200);
  assert.equal(upd.archived, true);
});

test("migration file and snapshot match the models", () => {
  const file = new URL("../migrations/0002_add_archived.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_add_archived.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  assert.ok(sql.includes(normalize('ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "archived" boolean DEFAULT false NOT NULL')), `unexpected migration SQL: ${sql}`);
});
