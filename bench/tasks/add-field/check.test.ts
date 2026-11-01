import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("pinned field and filter", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const u = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const user = { id: u.id, email: u.email, name: u.name, roles: [] };
  const a = await readJson(await app.request("/notes", { method: "POST", json: { title: "a", pinned: true }, as: user }), 201);
  assert.equal(a.pinned, true);
  const b = await readJson(await app.request("/notes", { method: "POST", json: { title: "b" }, as: user }), 201);
  assert.equal(b.pinned, false);
  const pinned = await readJson(await app.request("/notes?pinned=true", { as: user }), 200);
  assert.deepEqual(pinned.map((n: { title: string }) => n.title), ["a"]);
  const all = await readJson(await app.request("/notes", { as: user }), 200);
  assert.equal(all.length, 2);
  const upd = await readJson(await app.request(`/notes/${b.id}`, { method: "PATCH", json: { pinned: true }, as: user }), 200);
  assert.equal(upd.pinned, true);
});
