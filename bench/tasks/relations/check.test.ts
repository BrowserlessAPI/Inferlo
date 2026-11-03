import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, type Adapter } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("GET /notes includes each note's owner with one extra query", async () => {
  const base = memory();
  const selects: string[] = [];
  const db: Adapter = Object.assign(Object.create(base) as Adapter, {
    select: (m: Parameters<Adapter["select"]>[0], q: Parameters<Adapter["select"]>[1]) => {
      selects.push(m.name);
      return base.select(m, q);
    },
  });
  const app = createApp({ models, routes: [notes], db, auth: { resolve: () => null } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "Ann" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "Ben" });
  for (const title of ["one", "two", "three"]) await app.db.notes.insert({ title, ownerId: a.id });
  await app.db.notes.insert({ title: "other", ownerId: b.id });
  selects.length = 0;
  const list = await readJson(await app.request("/notes", { as: { id: a.id, email: a.email, name: a.name, roles: [] } }), 200);
  assert.equal(list.length, 3);
  for (const note of list) {
    assert.equal(note.ownerId, a.id);
    assert.equal(note.owner.id, a.id);
    assert.equal(note.owner.name, "Ann");
    assert.equal(note.owner.email, "a@x.io");
  }
  assert.equal(selects.filter((name) => name === "users").length, 1, "owners must be loaded with one query");
  assert.ok(selects.length <= 2, `expected at most 2 queries, got ${selects.join(", ")}`);
});
