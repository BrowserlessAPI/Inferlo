import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("POST /notes allows 5 per minute per user", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const asB = { id: b.id, email: b.email, name: b.name, roles: [] };
  for (let i = 0; i < 5; i++) assert.equal((await app.request("/notes", { method: "POST", json: { title: `n${i}` }, as: asA })).status, 201);
  const blocked = await app.request("/notes", { method: "POST", json: { title: "n6" }, as: asA });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, "IL2005");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(await app.db.notes.count({ ownerId: a.id }), 5);
  assert.equal((await app.request("/notes", { method: "POST", json: { title: "b1" }, as: asB })).status, 201);
  assert.equal((await app.request("/notes", { as: asA })).status, 200);
});
