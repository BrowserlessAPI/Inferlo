import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("GET /notes/stats is cached per user in ctx.cache and invalidated by creates and deletes", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const asB = { id: b.id, email: b.email, name: b.name, roles: [] };
  const stats = async (as: typeof asA) => {
    const res = await app.request("/notes/stats", { as });
    assert.equal(res.status, 200);
    return res.json();
  };
  assert.equal((await app.request("/notes/stats")).status, 401, "private");
  await app.db.notes.insert({ title: "a1", ownerId: a.id });
  assert.deepEqual(await stats(asA), { count: 1 });
  assert.deepEqual(await stats(asB), { count: 0 }, "per user");
  await app.db.notes.insert({ title: "a2", ownerId: a.id });
  assert.deepEqual(await stats(asA), { count: 1 }, "served from the cache");
  const created = await app.request("/notes", { method: "POST", json: { title: "a3" }, as: asA });
  assert.equal(created.status, 201);
  assert.deepEqual(await stats(asA), { count: 3 }, "creating a note invalidates the cache");
  const id = (await created.json()).id;
  assert.equal((await app.request(`/notes/${id}`, { method: "DELETE", as: asA })).status, 204);
  assert.deepEqual(await stats(asA), { count: 2 }, "deleting a note invalidates the cache");
  await app.cache.invalidate("notes");
  await app.db.notes.insert({ title: "b1", ownerId: b.id });
  assert.deepEqual(await stats(asB), { count: 1 }, "tagged \"notes\"");
  await app.db.notes.insert({ title: "b2", ownerId: b.id });
  assert.deepEqual(await stats(asB), { count: 1 });
});
