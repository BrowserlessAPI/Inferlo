import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { planMigration } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("the color field is gone from the model", () => {
  const notes = models.find((m) => m.name === "notes")!;
  assert.equal("color" in notes.fields, false);
});

test("the MySQL drop migration and snapshot match the models", () => {
  const file = new URL("../migrations/0002_drop_color.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_drop_color.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.equal(snapshot.dialect, "mysql", "the snapshot is still the MySQL one");
  assert.deepEqual(planMigration(models, snapshot, { dialect: "mysql" }).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  assert.equal(sql, normalize("ALTER TABLE `notes` DROP COLUMN `color`;"), `unexpected migration SQL: ${sql}`);
});
