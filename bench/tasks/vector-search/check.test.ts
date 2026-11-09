import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("notes are embedded when created and searched by meaning, per user", async () => {
  const usage: { for?: string; kind: string }[] = [];
  const app = createApp({
    models,
    routes: [notes],
    db: memory(),
    auth: { resolve: () => null },
    ai: { providers: { mock: mockProvider({ respond: () => "" }) }, models: { embed: "mock:e", fast: "mock:f" }, onUsage: (u) => void usage.push(u) },
  });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const asB = { id: b.id, email: b.email, name: b.name, roles: [] };
  for (const title of ["buy milk", "quarterly report", "call the plumber"]) {
    assert.equal((await app.request("/notes", { method: "POST", json: { title }, as: asA })).status, 201);
  }
  assert.equal((await app.request("/notes", { method: "POST", json: { title: "buy milk" }, as: asB })).status, 201);
  assert.ok(usage.some((u) => u.kind === "embed" && u.for === a.id));
  const stored = await app.db.notes.findMany({ where: { ownerId: a.id } });
  assert.equal(stored.length, 3);
  for (const note of stored) assert.equal((note as { embedding?: number[] }).embedding?.length, 8);

  const { embeddings } = await app.ai.embed({ model: "embed", input: "buy milk\n\n" });
  const exact = await app.db.notes.findOne({ title: "buy milk", ownerId: a.id });
  assert.deepEqual((exact as { embedding?: number[] }).embedding, embeddings[0]);

  const hits = await readJson(await app.request("/notes/search?q=" + encodeURIComponent("buy milk\n\n"), { as: asA }), 200);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].title, "buy milk");
  assert.equal(hits[0].id, exact!.id);
  assert.ok(Math.abs(hits[0].distance) < 1e-9);
  assert.ok(hits[1].distance >= hits[0].distance && hits[2].distance >= hits[1].distance);
  assert.deepEqual(Object.keys(hits[0]).sort(), ["distance", "id", "title"]);
  const other = await readJson(await app.request("/notes/search?q=milk", { as: asB }), 200);
  assert.equal(other.length, 1);
  assert.equal((await app.request("/notes/search?q=", { as: asA })).status, 422);
  assert.equal((await app.request("/notes/search?q=milk")).status, 401);
});
