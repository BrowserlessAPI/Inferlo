import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("GET /notes pages through the user's notes with a cursor, newest first", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "Ann" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "Ben" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const created = [];
  for (let i = 0; i < 25; i++) {
    created.push(await app.db.notes.insert({ title: `n${i}`, ownerId: a.id }));
    if (i % 5 === 0) await app.db.notes.insert({ title: "other", ownerId: b.id });
  }
  const newestFirst = [...created].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1)).map((n) => n.id);

  const first = await readJson(await app.request("/notes", { as: asA }), 200);
  assert.equal(first.items.length, 20);
  assert.equal(typeof first.nextCursor, "string");
  const second = await readJson(await app.request(`/notes?cursor=${encodeURIComponent(first.nextCursor)}`, { as: asA }), 200);
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.items, ...second.items].map((n: { id: string }) => n.id), newestFirst);
  for (const n of [...first.items, ...second.items]) assert.equal(n.ownerId, a.id);

  const small = await readJson(await app.request("/notes?limit=10", { as: asA }), 200);
  assert.equal(small.items.length, 10);
  // A note added after the first page does not shift the next page.
  await app.db.notes.insert({ title: "late", ownerId: a.id });
  const next = await readJson(await app.request(`/notes?limit=10&cursor=${encodeURIComponent(small.nextCursor)}`, { as: asA }), 200);
  assert.deepEqual(next.items.map((n: { id: string }) => n.id), newestFirst.slice(10, 20));

  assert.equal((await app.request("/notes?cursor=garbage", { as: asA })).status, 400);
  assert.equal((await app.request("/notes?limit=500", { as: asA })).status, 422);
});
