import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { planMigration } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("the model has colour and longer titles", () => {
  const notes = models.find((m) => m.name === "notes")!;
  assert.equal("color" in notes.fields, false);
  assert.ok("colour" in notes.fields);
  assert.equal((notes.fields as Record<string, { def: { max?: number } }>).title!.def.max, 400);
});

test("the MySQL migration renames the column and changes the title, and the snapshot matches the models", () => {
  const file = new URL("../migrations/0002_colour_longer_titles.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_colour_longer_titles.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.equal(snapshot.dialect, "mysql", "the snapshot is still the MySQL one");
  assert.deepEqual(planMigration(models, snapshot, { dialect: "mysql" }).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  const expected = normalize("ALTER TABLE `notes` RENAME COLUMN `color` TO `colour`; ALTER TABLE `notes` MODIFY COLUMN `title` VARCHAR(400) NOT NULL;");
  assert.equal(sql, expected, `unexpected migration SQL: ${sql}`);
});
