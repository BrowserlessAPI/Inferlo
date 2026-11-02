import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, planMigration } from "@browserlessapi/inferlo";
import { models, Note } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("note titles allow 500 characters, and not more", async () => {
  const title = (Note.fields as Record<string, { def: { max?: number; min?: number } }>).title;
  assert.ok(title, "notes has no title field");
  assert.equal(title.def.max, 500);
  assert.equal(title.def.min, 1);
  const app = createApp({ models, routes: [], db: memory(), auth: { resolve: () => null } });
  const user = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const note = await app.db.notes.insert({ title: "x".repeat(500), ownerId: user.id });
  assert.equal(note.title.length, 500);
  await assert.rejects(app.db.notes.insert({ title: "x".repeat(501), ownerId: user.id }));
});

test("migration file and snapshot match the models", () => {
  const file = new URL("../migrations/0002_longer_titles.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_longer_titles.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  const statement = normalize(`ALTER TABLE "notes" ALTER COLUMN "title" TYPE varchar(500)`);
  assert.ok(sql.includes(statement), `migration is missing: ${statement}\ngot: ${sql}`);
  assert.ok(!/drop column|add column/.test(sql), `the title column must be changed, not dropped and added again\ngot: ${sql}`);
});
