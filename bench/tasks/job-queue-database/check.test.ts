import assert from "node:assert/strict";
import { test } from "node:test";

// Imports src/app.ts again with a different DATABASE_URL (the query string makes a fresh module).
async function loadApp(databaseUrl: string | undefined, tag: string) {
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  const mod = await import(new URL(`../src/app.ts?${tag}`, import.meta.url).href);
  return mod.app;
}

test("with DATABASE_URL, jobs are queued in Postgres", async () => {
  // Nothing listens on this port: a database-backed queue must fail to enqueue, an in-memory one would not.
  const app = await loadApp("postgres://inferlo:none@127.0.0.1:9/none", "pg");
  const countNotes = app.jobs.list.find((j: { name: string }) => j.name === "count-notes");
  assert.ok(countNotes, 'the job "count-notes" must be registered in createApp');
  await assert.rejects(app.jobs.enqueue(countNotes, {}), "enqueue must write to the database when DATABASE_URL is set");
  await app.db.$close();
});

test("without DATABASE_URL, the in-memory queue runs the job", async () => {
  const app = await loadApp(undefined, "memory");
  const countNotes = app.jobs.list.find((j: { name: string }) => j.name === "count-notes");
  assert.ok(countNotes, 'the job "count-notes" must be registered in createApp');
  await app.jobs.enqueue(countNotes, {});
  const result = await app.jobs.runDue();
  assert.equal(result.done, 1);
  assert.equal(result.failed + result.retried, 0);
});
