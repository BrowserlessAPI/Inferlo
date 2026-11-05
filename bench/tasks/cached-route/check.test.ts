import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("GET /notes is cached per user with the route option and invalidated by POST /notes", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const route = app.describe().routes.find((r) => r.method === "GET" && r.path === "/notes");
  assert.deepEqual(route?.cache, { ttlMs: 30_000, by: "user", tags: ["notes"] }, "the route option cache");
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const asB = { id: b.id, email: b.email, name: b.name, roles: [] };
  const list = async (as: typeof asA) => {
    const res = await app.request("/notes", { as });
    assert.equal(res.status, 200);
    return { cache: res.headers.get("x-inferlo-cache"), titles: ((await res.json()) as { title: string }[]).map((n) => n.title) };
  };
  await app.db.notes.insert({ title: "a1", ownerId: a.id });
  assert.deepEqual(await list(asA), { cache: "MISS", titles: ["a1"] });
  await app.db.notes.insert({ title: "a2", ownerId: a.id });
  assert.deepEqual(await list(asA), { cache: "HIT", titles: ["a1"] }, "served from the cache");
  assert.deepEqual((await list(asB)).titles, [], "per user");
  assert.equal((await app.request("/notes", { method: "POST", json: { title: "a3" }, as: asA })).status, 201);
  const fresh = await list(asA);
  assert.equal(fresh.cache, "MISS", "POST /notes invalidated the cache");
  assert.deepEqual(fresh.titles.sort(), ["a1", "a2", "a3"]);
});
