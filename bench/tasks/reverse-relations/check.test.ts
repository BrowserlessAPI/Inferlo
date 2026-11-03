import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, type Adapter } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as admin from "../src/routes/admin.ts";

test("GET /admin/users includes each user's notes with one extra query", async () => {
  const base = memory();
  const selects: string[] = [];
  const db: Adapter = Object.assign(Object.create(base) as Adapter, {
    select: (m: Parameters<Adapter["select"]>[0], q: Parameters<Adapter["select"]>[1]) => {
      selects.push(m.name);
      return base.select(m, q);
    },
  });
  const app = createApp({ models, routes: [admin], db, auth: { resolve: () => null } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "Ann", role: "admin" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "Ben" });
  await app.db.users.insert({ email: "c@x.io", name: "Cy" });
  for (const title of ["one", "two"]) await app.db.notes.insert({ title, ownerId: b.id });
  await app.db.notes.insert({ title: "mine", ownerId: a.id });
  const member = { id: b.id, email: b.email, name: b.name, roles: ["member"] };
  assert.equal((await app.request("/admin/users", { as: member })).status, 403);
  selects.length = 0;
  const users = await readJson(await app.request("/admin/users", { as: { id: a.id, email: a.email, name: a.name, roles: ["admin"] } }), 200);
  assert.deepEqual(users.map((u: { email: string }) => u.email), ["a@x.io", "b@x.io", "c@x.io"]);
  assert.deepEqual(users[0].notes.map((n: { title: string }) => n.title), ["mine"]);
  assert.deepEqual(users[1].notes.map((n: { title: string }) => n.title).sort(), ["one", "two"]);
  for (const n of users[1].notes) assert.equal(n.ownerId, b.id);
  assert.deepEqual(users[2].notes, []);
  assert.equal(selects.filter((name) => name === "notes").length, 1, "notes must be loaded with one query");
  assert.ok(selects.length <= 2, `expected at most 2 queries, got ${selects.join(", ")}`);
});
