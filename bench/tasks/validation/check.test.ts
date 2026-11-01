import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("whitespace titles are rejected", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const u = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const user = { id: u.id, email: u.email, name: u.name, roles: [] };
  assert.equal((await readJson(await app.request("/notes", { method: "POST", json: { title: "   " }, as: user }), 422)).error.code, "IL1001");
  const ok = await readJson(await app.request("/notes", { method: "POST", json: { title: " ok " }, as: user }), 201);
  assert.equal((await app.request(`/notes/${ok.id}`, { method: "PATCH", json: { title: "\t" }, as: user })).status, 422);
});
