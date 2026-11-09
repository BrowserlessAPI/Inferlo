import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { planMigration } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("the color field is now colour", () => {
  const notes = models.find((m) => m.name === "notes")!;
  assert.equal("color" in notes.fields, false);
  assert.ok("colour" in notes.fields);
});

test("the SQLite migration renames the column and the snapshot matches the models", () => {
  const file = new URL("../migrations/0002_colour.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_colour.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.equal(snapshot.dialect, "sqlite", "the snapshot is still the SQLite one");
  assert.deepEqual(planMigration(models, snapshot, { dialect: "sqlite" }).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  assert.equal(sql, normalize('ALTER TABLE "notes" RENAME COLUMN "color" TO "colour";'), `unexpected migration SQL: ${sql}`);
});
