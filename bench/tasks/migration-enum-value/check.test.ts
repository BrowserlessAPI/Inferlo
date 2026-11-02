import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, planMigration } from "@browserlessapi/inferlo";
import { models, User } from "../src/models.ts";

const normalize = (sql: string) => sql.replace(/--.*$/gm, "").replace(/\s+/g, " ").replace(/\s*;\s*/g, ";").trim().toLowerCase();

test("users can have the viewer role, and member is still the default", async () => {
  const role = (User.fields as Record<string, { def: { values?: unknown[]; defaultValue?: unknown } }>).role;
  assert.ok(role, "users has no role field");
  assert.deepEqual(role.def.values, ["member", "admin", "viewer"]);
  const app = createApp({ models, routes: [], db: memory(), auth: { resolve: () => null } });
  const viewer = await app.db.users.insert({ email: "v@x.io", name: "V", role: "viewer" });
  assert.equal(viewer.role, "viewer");
  const member = await app.db.users.insert({ email: "m@x.io", name: "M" });
  assert.equal(member.role, "member");
});

test("migration file and snapshot match the models", () => {
  const file = new URL("../migrations/0002_add_viewer_role.sql", import.meta.url);
  assert.ok(existsSync(file), "migrations/0002_add_viewer_role.sql is missing");
  const snapshot = JSON.parse(readFileSync(new URL("../migrations/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(planMigration(models, snapshot).statements, [], "migrations/snapshot.json does not match the models");
  const sql = normalize(readFileSync(file, "utf8"));
  const expected = [
    `ALTER TABLE "users" DROP CONSTRAINT "users_role_check"`,
    `ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("role" IN ('member', 'admin', 'viewer'))`,
  ];
  let at = 0;
  for (const statement of expected) {
    const i = sql.indexOf(normalize(statement), at);
    assert.ok(i >= 0, `migration is missing (or has out of order): ${statement}\ngot: ${sql}`);
    at = i;
  }
});
