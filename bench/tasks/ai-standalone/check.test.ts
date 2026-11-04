import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("classify uses the standalone AI module with Anthropic and structured output", async () => {
  const source = readFileSync(new URL("../src/lib/classify.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/ai/, "imports the standalone AI entry point");
  assert.doesNotMatch(source, /createApp/, "does not use createApp");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: { url: string; body: any; key: string | null }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("x-api-key") });
    return Response.json({ content: [{ type: "text", text: '{"label":"bug"}' }], usage: { input_tokens: 10, output_tokens: 5 } });
  }) as typeof fetch;

  const mod = await import("../src/lib/classify.ts");
  const label = await mod.classify("The export button does nothing", "user-1");
  assert.equal(label, "bug");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /api\.anthropic\.com\/v1\/messages$/);
  assert.equal(requests[0]!.key, "test-key");
  assert.equal(requests[0]!.body.model, "claude-haiku-4-5");
  assert.match(JSON.stringify(requests[0]!.body), /The export button does nothing/);
  assert.match(String(requests[0]!.body.system), /JSON Schema/);
  assert.deepEqual(mod.ai.aliases.fast, ["anthropic:claude-haiku-4-5"]);
});
