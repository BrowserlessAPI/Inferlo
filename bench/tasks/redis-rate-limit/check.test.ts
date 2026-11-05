import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Starts src/app.ts in a fresh process (config is read once per process) and prints the readiness report.
function ready(redisUrl: string | undefined): { code: number | null; output: string } {
  const env = { ...process.env };
  delete env.REDIS_URL;
  if (redisUrl !== undefined) env.REDIS_URL = redisUrl;
  const script = `const { app } = await import(${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)});
const res = await app.request("/ready");
console.log(JSON.stringify({ status: res.status, report: await res.json() }));
process.exit(0);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10_000 });
  return { code: run.status, output: run.stdout + run.stderr };
}

test("without REDIS_URL, the app starts with in-memory rate limits", () => {
  const { code, output } = ready(undefined);
  assert.equal(code, 0, output);
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  assert.equal(result.status, 200);
  assert.equal(result.report.checks.redis, undefined, "no Redis check without REDIS_URL");
});

test("with REDIS_URL, the app connects to Redis at startup", () => {
  // Nothing listens on this port: an app that connects to REDIS_URL must not start.
  const { code, output } = ready("redis://127.0.0.1:9");
  assert.notEqual(code, 0, `the app started without reaching Redis: ${output}`);
});

test("with a reachable Redis, /ready checks it", { skip: process.env.INFERLO_TEST_REDIS_URL ? false : "set INFERLO_TEST_REDIS_URL" }, () => {
  const { code, output } = ready(process.env.INFERLO_TEST_REDIS_URL);
  assert.equal(code, 0, output);
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  assert.equal(result.status, 200);
  assert.equal(result.report.checks.redis?.status, "ok");
});
