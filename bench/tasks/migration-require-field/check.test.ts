import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, planMigration } from "@browserlessapi/kairo";
import { readJson } from "@browserlessapi/kairo/testing";
import { models, Note } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("body is required with an empty default", async () => {
  const body = (Note.fields as Record<string, { def: { optional?: boolean; nullable?: boolean; hasDefault?: boolean; defaultValue?: unknown } }>).body;
  assert.ok(body, "notes has no body field");
  assert.ok(!body.def.optional && !body.def.nullable, "body is still optional");
  assert.equal(body.def.defaultValue, "", 'body should default to ""');
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const u = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const user = { id: u.id, email: u.email, name: u.name, roles: [] };
  const note = await readJson(await app.request("/notes", { method: "POST", json: { title: "a" }, as: user }), 201);
  assert.equal(note.body, "");
});

test("migration file and snapshot match the models", () => {
  const file = new URL("../migrations/0002_require_body.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_require_body.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  const expected = [
    `ALTER TABLE "notes" ALTER COLUMN "body" SET DEFAULT ''`,
    `UPDATE "notes" SET "body" = '' WHERE "body" IS NULL`,
    `ALTER TABLE "notes" ALTER COLUMN "body" SET NOT NULL`,
  ];
  let at = 0;
  for (const statement of expected) {
    const i = sql.indexOf(normalize(statement), at);
    assert.ok(i >= 0, `migration is missing (or has out of order): ${statement}\ngot: ${sql}`);
    at = i;
  }
});
