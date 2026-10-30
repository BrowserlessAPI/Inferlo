import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@kairojs/core";
import { readJson } from "@kairojs/core/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("tag suggestions", async () => {
  const usage: { for?: string }[] = [];
  const app = createApp({
    models,
    routes: [notes],
    db: memory(),
    auth: { resolve: () => null },
    ai: { providers: { mock: mockProvider({ respond: () => '{"tags":["work","urgent"]}' }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) },
  });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const note = await app.db.notes.insert({ title: "Quarterly report", body: "Due Friday", ownerId: a.id });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const out = await readJson(await app.request(`/notes/${note.id}/tags-suggest`, { method: "POST", as: asA }), 200);
  assert.deepEqual(out, { tags: ["work", "urgent"] });
  assert.equal(usage[0]?.for, a.id);
  const asB = { id: b.id, email: b.email, name: b.name, roles: [] };
  assert.equal((await app.request(`/notes/${note.id}/tags-suggest`, { method: "POST", as: asB })).status, 404);
});
