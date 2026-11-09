import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

function makeApp() {
  return createApp({
    models,
    routes: [notes],
    db: memory(),
    auth: { resolve: () => null },
    // An answer that does not match its route's response schema fails the test (500 IL2016).
    validateResponses: "error",
    ai: { providers: { mock: mockProvider({ respond: () => '{"summary":"A short note."}' }) }, models: { fast: "mock:test" } },
  });
}

test("create, list, update and delete notes", async () => {
  const app = makeApp();
  const row = await app.db.users.insert({ email: "a@example.com", name: "A" });
  const user = { id: row.id, email: row.email, name: row.name, roles: [] };

  const note = await readJson(await app.request("/notes", { method: "POST", json: { title: "First" }, as: user }), 201);
  assert.equal(note.title, "First");

  const list = await readJson(await app.request("/notes", { as: user }), 200);
  assert.equal(list.length, 1);

  const updated = await readJson(await app.request(`/notes/${note.id}`, { method: "PATCH", json: { body: "Hello" }, as: user }), 200);
  assert.equal(updated.body, "Hello");

  const summary = await readJson(await app.request(`/notes/${note.id}/summary`, { method: "POST", as: user }), 200);
  assert.equal(summary.summary, "A short note.");

  assert.equal((await app.request(`/notes/${note.id}`, { method: "DELETE", as: user })).status, 204);
});

test("other users cannot read my notes", async () => {
  const app = makeApp();
  const a = await app.db.users.insert({ email: "a@example.com", name: "A" });
  const b = await app.db.users.insert({ email: "b@example.com", name: "B" });
  const note = await app.db.notes.insert({ title: "Private", authorId: a.id });
  const res = await app.request(`/notes/${note.id}`, { as: { id: b.id, email: b.email, name: b.name, roles: [] } });
  assert.equal(res.status, 404);
});

test("requests without a key are rejected", async () => {
  const res = await makeApp().request("/notes");
  assert.equal(res.status, 401);
});
