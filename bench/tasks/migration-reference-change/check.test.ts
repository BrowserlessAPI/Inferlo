import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { planMigration } from "@browserlessapi/inferlo";
import { ApiKey, models, Note } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();
const onDelete = (m: { fields: unknown }, field: string) => (m.fields as Record<string, { def: { refTable?: string; onDelete?: string } }>)[field]?.def;

test("notes restrict deletes of their owner; API keys still cascade", () => {
  assert.equal(onDelete(Note, "ownerId")?.refTable, "users");
  assert.equal(onDelete(Note, "ownerId")?.onDelete ?? "restrict", "restrict");
  assert.equal(onDelete(ApiKey, "userId")?.onDelete, "cascade");
});

test("migration file and snapshot match the models", () => {
  const file = new URL("../migrations/0002_restrict_note_owner.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_restrict_note_owner.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  const expected = [
    `ALTER TABLE "notes" DROP CONSTRAINT "notes_owner_id_fkey"`,
    `ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT`,
  ];
  let at = 0;
  for (const statement of expected) {
    const i = sql.indexOf(normalize(statement), at);
    assert.ok(i >= 0, `migration is missing (or has out of order): ${statement}\ngot: ${sql}`);
    at = i;
  }
  assert.doesNotMatch(sql, /api_keys/, "API keys are unchanged");
});
