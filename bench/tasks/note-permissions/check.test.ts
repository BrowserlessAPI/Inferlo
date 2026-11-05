import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";
import { access } from "../src/permissions.ts";

test("notes.delete and notes.stats are named permissions used by the routes", async () => {
  assert.match(readFileSync(new URL("../src/permissions.ts", import.meta.url), "utf8"), /permissions\(/, "uses permissions()");
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /permissions:\s*access/, "passes access to createApp");
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null }, permissions: access });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const admin = await app.db.users.insert({ email: "admin@x.io", name: "Admin", role: "admin" });
  const as = (u: { id: string; email: string; name: string }, roles: string[] = []) => ({ id: u.id, email: u.email, name: u.name, roles });

  const first = await app.db.notes.insert({ title: "one", ownerId: a.id });
  const second = await app.db.notes.insert({ title: "two", ownerId: a.id });
  await app.db.notes.insert({ title: "three", ownerId: b.id });

  assert.equal(await access.can("notes.stats", { user: as(admin, ["admin"]) }), true);
  assert.equal(await access.can("notes.stats", { user: as(a) }), false);

  const denied = await readJson(await app.request(`/notes/${first.id}`, { method: "DELETE", as: as(b) }), 403);
  assert.equal(denied.error.code, "IL3004");
  assert.equal((await app.db.notes.get(first.id)).title, "one", "the note stays");
  assert.equal((await app.request(`/notes/${first.id}`, { method: "DELETE", as: as(a) })).status, 204, "the owner");
  assert.equal((await app.request(`/notes/${second.id}`, { method: "DELETE", as: as(admin, ["admin"]) })).status, 204, "an admin");

  assert.equal((await readJson(await app.request("/notes/stats", { as: as(a) }), 403)).error.code, "IL3004");
  assert.deepEqual(await readJson(await app.request("/notes/stats", { as: as(admin, ["admin"]) }), 200), { total: 1 });
  assert.equal(app.describe().routes.find((r) => r.path === "/notes/stats")?.permission, "notes.stats", "checked by the route option");
});
