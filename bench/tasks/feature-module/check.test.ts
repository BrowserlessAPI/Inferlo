import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../src/app.ts";

test("the notes feature is a module with its model and routes", () => {
  const d = app.describe();
  const notes = d.modules.find((m) => m.name === "notes");
  assert.ok(notes, "a module named notes is registered");
  assert.equal(notes.description, "Personal notes with AI summaries.");
  assert.deepEqual(notes.models, ["notes"]);
  for (const r of ["GET /notes", "POST /notes", "GET /notes/:id", "PATCH /notes/:id", "DELETE /notes/:id"]) assert.ok(notes.routes.includes(r), `${r} is in the notes module`);
  assert.equal(d.models.find((m) => m.name === "users")?.module, undefined, "users stays in the app");
  assert.equal(d.models.find((m) => m.name === "api_keys")?.module, undefined, "api_keys stays in the app");
  const doc = app.openapi() as { tags?: { name: string }[] };
  assert.ok(doc.tags?.some((t) => t.name === "notes"), "OpenAPI lists the notes module as a tag");
});

test("notes endpoints still work", async () => {
  const row = await app.db.users.insert({ email: "module@example.com", name: "M" });
  const user = { id: row.id, email: row.email, name: row.name, roles: [] };
  const created = await app.request("/notes", { method: "POST", json: { title: "Hello" }, as: user });
  assert.equal(created.status, 201);
  const list = (await (await app.request("/notes", { as: user })).json()) as { title: string }[];
  assert.deepEqual(list.map((n) => n.title), ["Hello"]);
});
