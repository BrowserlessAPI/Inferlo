import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Starts src/app.ts in a fresh process (config is read once per process), deletes a note and prints the event
// transport and the newest entry of the note.deleted stream.
function start(redisUrl: string | undefined, readStream = false): { code: number | null; output: string } {
  const env = { ...process.env };
  delete env.REDIS_URL;
  delete env.CHECK_READ_STREAM;
  if (redisUrl !== undefined) env.REDIS_URL = redisUrl;
  if (readStream) env.CHECK_READ_STREAM = "1";
  const script = `const { app } = await import(${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)});
const user = await app.db.users.insert({ email: "a@x.io", name: "A" });
const as = { id: user.id, email: user.email, name: user.name, roles: [] };
const created = await app.request("/notes", { method: "POST", as, json: { title: "Old", body: "" } });
const note = await created.json();
const deleted = await app.request("/notes/" + note.id, { method: "DELETE", as });
let entry = null;
if (process.env.CHECK_READ_STREAM) {
  const { createClient } = await import("redis");
  const redis = await createClient({ url: process.env.REDIS_URL }).connect();
  const [last] = await redis.xRevRange("inferlo:events:note.deleted", "+", "-", { COUNT: 1 });
  entry = last ? JSON.parse(last.message.payload) : null;
  await redis.close();
}
console.log(JSON.stringify({ transport: app.describe().eventTransport ?? null, status: deleted.status, noteId: note.id, ownerId: user.id, entry }));
process.exit(0);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10_000 });
  return { code: run.status, output: run.stdout + run.stderr };
}

const last = (output: string) => JSON.parse(output.trim().split("\n").at(-1)!);

test("without REDIS_URL, events stay in the app and deleting a note still works", () => {
  const { code, output } = start(undefined);
  assert.equal(code, 0, output);
  const result = last(output);
  assert.equal(result.transport, null);
  assert.equal(result.status, 204);
});

test("with REDIS_URL, the app connects to Redis at startup", () => {
  // Nothing listens on this port: an app that connects to REDIS_URL must not start.
  const { code, output } = start("redis://127.0.0.1:9");
  assert.notEqual(code, 0, `the app started without reaching Redis: ${output}`);
});

test("with a reachable Redis, DELETE /notes/:id sends note.deleted through the Redis transport", { skip: process.env.INFERLO_TEST_REDIS_URL ? false : "set INFERLO_TEST_REDIS_URL" }, () => {
  const { code, output } = start(process.env.INFERLO_TEST_REDIS_URL, true);
  assert.equal(code, 0, output);
  const result = last(output);
  assert.equal(result.transport, "redis");
  assert.equal(result.status, 204);
  assert.deepEqual(result.entry, { noteId: result.noteId, ownerId: result.ownerId });
});
