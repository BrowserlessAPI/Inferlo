import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, planMigration } from "@browserlessapi/kairo";
import { models, Note } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("notes have an optional dueAt date", async () => {
  assert.ok("dueAt" in Note.fields, "notes has no dueAt field");
  const app = createApp({ models, routes: [], db: memory(), auth: { resolve: () => null } });
  const u = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const due = new Date("2026-12-01T00:00:00Z");
  const withDue = await app.db.notes.insert({ title: "a", ownerId: u.id, dueAt: due });
  assert.equal(new Date(withDue.dueAt as Date).toISOString(), due.toISOString());
  const without = await app.db.notes.insert({ title: "b", ownerId: u.id });
  assert.equal(without.dueAt ?? null, null);
});

test("migration file matches the models and the snapshot is saved in the current format", () => {
  const file = new URL("../migrations/0002_add_due_at.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_add_due_at.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.equal(snapshot.kairo, 2, "migrations/snapshot.json is not in the current format (kairo: 2)");
  const plan = planMigration(models, snapshot);
  assert.deepEqual(plan.statements, [], "migrations/snapshot.json does not match the models");
  assert.deepEqual(snapshot, plan.snapshot, "migrations/snapshot.json is not what kairo db migrate would write");
  const sql = normalize(readFileSync(file, "utf8"));
  assert.ok(sql.includes(normalize('ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "due_at" timestamptz')), `unexpected migration SQL: ${sql}`);
});
