import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("note updates and deletes are in the audit log with user, record and changes", async () => {
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null } });
  const db = app.db as any;
  assert.ok(db.audit_log, "the audit_log table is in the app");
  const owner = await db.users.insert({ email: "o@x.io", name: "Owner" });
  const as = { id: owner.id, email: owner.email, name: owner.name, roles: [] as string[] };
  const note = await db.notes.insert({ title: "Old", body: "b", ownerId: owner.id });

  await readJson(await app.request(`/notes/${note.id}`, { method: "PATCH", json: { title: "New" }, as }), 200);
  const update = await db.audit_log.findOne({ action: "notes.update" });
  assert.ok(update, "an entry for the update");
  assert.equal(update.userId, owner.id);
  assert.equal(update.model, "notes");
  assert.equal(update.recordId, note.id);
  assert.deepEqual(update.changes.title, { from: "Old", to: "New" });
  assert.equal(update.changes.body, undefined, "only changed fields");

  assert.equal((await app.request(`/notes/${note.id}`, { method: "DELETE", as })).status, 204);
  const deleted = await db.audit_log.findOne({ action: "notes.delete" });
  assert.ok(deleted, "an entry for the delete");
  assert.equal(deleted.recordId, note.id);
  assert.equal(deleted.userId, owner.id);
});
