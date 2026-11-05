import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Starts src/app.ts in a fresh process (config is read once per process), enqueues "count-notes", runs due jobs
// and prints which queue the app uses.
function start(redisUrl: string | undefined): { code: number | null; output: string } {
  const env = { ...process.env };
  delete env.REDIS_URL;
  if (redisUrl !== undefined) env.REDIS_URL = redisUrl;
  const script = `const { app } = await import(${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)});
const countNotes = app.jobs.list.find((j) => j.name === "count-notes");
if (!countNotes) throw new Error('the job "count-notes" must be registered in createApp');
const queued = await app.jobs.enqueue(countNotes, {});
const result = await app.jobs.runDue();
const stored = await app.jobs.get(queued.id);
console.log(JSON.stringify({ queue: app.describe().jobQueue, result, status: stored && stored.status }));
process.exit(0);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10_000 });
  return { code: run.status, output: run.stdout + run.stderr };
}

const last = (output: string) => JSON.parse(output.trim().split("\n").at(-1)!);

test("without REDIS_URL, the app uses the in-memory queue and runs the job", () => {
  const { code, output } = start(undefined);
  assert.equal(code, 0, output);
  assert.deepEqual(last(output), { queue: "memory", result: { done: 1, retried: 0, failed: 0 }, status: "done" });
});

test("with REDIS_URL, the app connects to Redis at startup", () => {
  // Nothing listens on this port: an app that connects to REDIS_URL must not start.
  const { code, output } = start("redis://127.0.0.1:9");
  assert.notEqual(code, 0, `the app started without reaching Redis: ${output}`);
});

test("with a reachable Redis, jobs are queued in Redis", { skip: process.env.INFERLO_TEST_REDIS_URL ? false : "set INFERLO_TEST_REDIS_URL" }, () => {
  const { code, output } = start(process.env.INFERLO_TEST_REDIS_URL);
  assert.equal(code, 0, output);
  const result = last(output);
  assert.equal(result.queue, "redis");
  assert.equal(result.status, "done");
  assert.equal(result.result.failed + result.result.retried, 0);
});
