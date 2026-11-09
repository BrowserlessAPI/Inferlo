import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { planMigration } from "@browserlessapi/inferlo";
import { models, Note } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("notes have authorId instead of ownerId", () => {
  const fields = Note.fields as Record<string, { def: { refTable?: string; onDelete?: string } }>;
  assert.equal(fields.ownerId, undefined, "ownerId is still a field");
  assert.equal(fields.authorId?.def.refTable, "users");
  assert.equal(fields.authorId?.def.onDelete, "cascade");
  assert.doesNotMatch(readFileSync(new URL("../src/routes/notes.ts", import.meta.url), "utf8"), /ownerId/);
});

test("the migration renames the column (no drop), and the snapshot matches the models", () => {
  const file = new URL("../migrations/0002_rename_note_owner.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_rename_note_owner.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  assert.doesNotMatch(sql, /drop column|add column/, "a rename must not drop the column");
  const expected = [
    `ALTER TABLE "notes" RENAME COLUMN "owner_id" TO "author_id"`,
    `ALTER TABLE "notes" RENAME CONSTRAINT "notes_owner_id_fkey" TO "notes_author_id_fkey"`,
    `ALTER INDEX "notes_owner_id_idx" RENAME TO "notes_author_id_idx"`,
  ];
  for (const statement of expected) assert.ok(sql.includes(normalize(statement)), `migration is missing: ${statement}\ngot: ${sql}`);
});
