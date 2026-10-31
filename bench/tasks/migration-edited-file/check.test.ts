import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { model, planMigration } from "@browserlessapi/kairo";
import { ApiKey, models, Note, User } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").replace(/\s*([(),])\s*/g, "$1").trim().toLowerCase();
const read = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");

test("notes keeps the pinned field and the snapshot matches the models", () => {
  assert.ok("pinned" in Note.fields, "notes lost its pinned field");
  const snapshot = JSON.parse(read("snapshot.json"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
});

test("0001_init.sql is back to the SQL that was applied", () => {
  const { pinned: _pinned, ...before } = Note.fields;
  const applied = planMigration([User, ApiKey, model("notes", before)]).statements;
  assert.equal(normalize(read("0001_init.sql")), normalize(applied.join(";\n\n") + ";"), "migrations/0001_init.sql differs from the applied SQL");
});

test("0002_add_pinned.sql adds the column", () => {
  const file = new URL("../migrations/0002_add_pinned.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_add_pinned.sql is missing");
  assert.equal(normalize(readFileSync(file, "utf8")), normalize('ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false NOT NULL;'));
});
