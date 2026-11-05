import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

/** wrangler.jsonc without comments and trailing commas. */
function wrangler(): Record<string, unknown> {
  const file = new URL("wrangler.jsonc", root);
  assert.ok(existsSync(file), "wrangler.jsonc must exist in the project root");
  const text = readFileSync(file, "utf8")
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text) as Record<string, unknown>;
}

test("wrangler.jsonc runs src/worker.ts with bindings in the environment", () => {
  const config = wrangler();
  assert.equal(config.name, "notes-api");
  assert.equal(String(config.main).replace(/^\.\//, ""), "src/worker.ts");
  const flags = (config.compatibility_flags ?? []) as string[];
  assert.ok(flags.includes("nodejs_compat"), "vars and secrets reach process.env (and config()) only with the nodejs_compat flag");
  assert.ok(typeof config.compatibility_date === "string" && config.compatibility_date >= "2025-04-01", "nodejs_compat fills process.env from compatibility date 2025-04-01");
});

test("the Worker's default export serves the whole app", async () => {
  const worker = (await import(new URL("src/worker.ts", root).href)).default as { fetch(req: Request, env: unknown, ctx: unknown): Promise<Response> };
  assert.equal(typeof worker?.fetch, "function", "src/worker.ts must export default an object with fetch (export default app)");
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const health = await worker.fetch(new Request("https://notes.example.com/health"), {}, ctx);
  assert.equal(health.status, 200);
  const openapi = await worker.fetch(new Request("https://notes.example.com/openapi.json"), {}, ctx);
  assert.equal(openapi.status, 200);
  assert.ok(((await openapi.json()) as { paths: Record<string, unknown> }).paths["/notes"]);
});
