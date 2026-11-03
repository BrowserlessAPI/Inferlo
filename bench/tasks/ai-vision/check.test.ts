import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("POST /notes/from-image sends the image to the model and creates the note", async () => {
  const usage: { for?: string }[] = [];
  const mock = mockProvider({ respond: () => '{"title":"Groceries","body":"Milk, eggs"}' });
  const app = createApp({
    models,
    routes: [notes],
    db: memory(),
    auth: { resolve: () => null },
    ai: { providers: { mock }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) },
  });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const res = await app.request("/notes/from-image", { method: "POST", as: asA, json: { imageUrl: "https://example.com/note.jpg" } });
  const note = await readJson(res, 201);
  assert.equal(note.title, "Groceries");
  assert.equal(note.body, "Milk, eggs");
  assert.equal(note.ownerId, a.id);
  const images = mock.calls[0]!.messages.flatMap((m) => m.images ?? []);
  assert.deepEqual(images, [{ url: "https://example.com/note.jpg" }]);
  assert.equal(usage[0]?.for, a.id);
  assert.equal((await app.db.notes.findMany({ where: { ownerId: a.id } })).length, 1);
  assert.equal((await app.request("/notes/from-image", { method: "POST", as: asA, json: { imageUrl: "not a url" } })).status, 422);
});
