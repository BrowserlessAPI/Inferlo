import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "kairojs";
import { readJson } from "kairojs/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("cannot edit other users' notes", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const note = await app.db.notes.insert({ title: "mine", ownerId: a.id });
  const asB = { id: b.id, email: b.email, name: b.name, roles: [] };
  const res = await app.request(`/notes/${note.id}`, { method: "PATCH", json: { title: "hacked" }, as: asB });
  assert.equal(res.status, 404);
  assert.equal((await app.db.notes.get(note.id)).title, "mine");
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  assert.equal((await readJson(await app.request(`/notes/${note.id}`, { method: "PATCH", json: { title: "ok" }, as: asA }), 200)).title, "ok");
});
