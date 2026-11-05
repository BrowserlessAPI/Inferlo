import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Starts src/app.ts in a fresh process (config is read once per process) and prints which cache store it uses.
function start(redisUrl: string | undefined): { code: number | null; output: string } {
  const env = { ...process.env };
  delete env.REDIS_URL;
  if (redisUrl !== undefined) env.REDIS_URL = redisUrl;
  const script = `const { app } = await import(${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)});
await app.cache.set("check", { ok: true }, { ttlMs: 5000 });
console.log(JSON.stringify({ store: app.describe().cache, value: await app.cache.get("check") }));
process.exit(0);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10_000 });
  return { code: run.status, output: run.stdout + run.stderr };
}

const last = (output: string) => JSON.parse(output.trim().split("\n").at(-1)!);

test("without REDIS_URL, the app uses the in-memory cache", () => {
  const { code, output } = start(undefined);
  assert.equal(code, 0, output);
  assert.deepEqual(last(output), { store: "memory", value: { ok: true } });
});

test("with REDIS_URL, the app connects to Redis at startup", () => {
  // Nothing listens on this port: an app that connects to REDIS_URL must not start.
  const { code, output } = start("redis://127.0.0.1:9");
  assert.notEqual(code, 0, `the app started without reaching Redis: ${output}`);
});

test("with a reachable Redis, the cache is in Redis", { skip: process.env.INFERLO_TEST_REDIS_URL ? false : "set INFERLO_TEST_REDIS_URL" }, () => {
  const { code, output } = start(process.env.INFERLO_TEST_REDIS_URL);
  assert.equal(code, 0, output);
  assert.deepEqual(last(output), { store: "redis", value: { ok: true } });
});
