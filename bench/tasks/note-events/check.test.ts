import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson } from "@browserlessapi/inferlo/testing";
import { app } from "../src/app.ts";

test("DELETE /notes/:id publishes note.deleted, which queues the notify-owner job", async () => {
  const events = app.describe().events as { name: string; jobs: string[]; payload: { properties?: Record<string, unknown> } }[];
  const deleted = events.find((e) => e.name === "note.deleted");
  assert.ok(deleted, "the note.deleted event has a subscription in the app");
  assert.deepEqual(deleted.jobs, ["notify-owner"]);
  assert.deepEqual(Object.keys(deleted.payload.properties ?? {}).sort(), ["noteId", "ownerId"]);

  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const note = await readJson(await app.request("/notes", { method: "POST", as: asA, json: { title: "Old", body: "" } }), 201);
  assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 0, failed: 0 }, "creating a note publishes nothing");
  assert.equal((await app.request(`/notes/${note.id}`, { method: "DELETE", as: asA })).status, 204);
  const logged: unknown[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 }, "the job runs from the queue, after the request");
  } finally {
    console.log = log;
  }
  assert.ok(logged.some((line) => String(line).includes(note.id)), "notify-owner logs the deleted note's id");
});
