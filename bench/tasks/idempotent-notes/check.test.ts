import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("POST /notes runs once per Idempotency-Key", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const post = (key?: string, title = "Hi") => app.request("/notes", { method: "POST", json: { title }, headers: key ? { "idempotency-key": key } : {}, as: asA });
  const first = await post("k-1");
  assert.equal(first.status, 201);
  const note = await first.json();
  const retry = await post("k-1");
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), note, "the retry gets the first answer");
  assert.equal(retry.headers.get("idempotent-replayed"), "true", "uses Inferlo's idempotency keys");
  assert.equal(await app.db.notes.count({ ownerId: a.id }), 1);
  assert.equal((await post("k-1", "Other")).status, 422, "a key reused for another note is refused");
  assert.equal((await post("k-2")).status, 201);
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  assert.equal(await app.db.notes.count({ ownerId: a.id }), 4);
});
