import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson } from "@browserlessapi/inferlo/testing";
import { app } from "../src/app.ts";

test("POST /notes queues a job that upper-cases the title", async () => {
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const note = await readJson(await app.request("/notes", { method: "POST", as: asA, json: { title: "Buy milk", body: "" } }), 201);
  assert.equal(note.title, "Buy milk");
  assert.equal((await app.db.notes.get(note.id)).title, "Buy milk", "the title must change in the job, not in the request");
  assert.ok(app.jobs.list.some((j) => j.name === "uppercase-title"), "the job must be registered in createApp");
  const result = await app.jobs.runDue();
  assert.equal(result.done, 1);
  assert.equal(result.failed + result.retried, 0);
  assert.equal((await app.db.notes.get(note.id)).title, "BUY MILK");
});
