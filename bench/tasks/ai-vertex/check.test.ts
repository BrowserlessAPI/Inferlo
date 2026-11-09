import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("translate calls Gemini on Vertex AI in europe-west4 with an access token and structured output", async () => {
  const source = readFileSync(new URL("../src/lib/translate.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/ai/, "imports the standalone AI entry point");
  assert.doesNotMatch(source, /createApp|aiSdk|openaiCompatible/, "uses the built-in adapter");

  process.env.GCP_PROJECT = "acme-prod-42";
  process.env.GCP_ACCESS_TOKEN = "ya29.test-token";
  const requests: { url: string; body: any; headers: Headers }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return Response.json({ choices: [{ message: { content: '{"translation":"Bonjour le monde"}' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
  }) as typeof fetch;

  const mod = await import("../src/lib/translate.ts");
  assert.deepEqual(await mod.translate("Hello world", "French", "user-1"), { translation: "Bonjour le monde" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://europe-west4-aiplatform.googleapis.com/v1/projects/acme-prod-42/locations/europe-west4/endpoints/openapi/chat/completions");
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer ya29.test-token");
  assert.equal(requests[0]!.body.model, "google/gemini-2.5-flash");
  assert.equal(requests[0]!.body.response_format.type, "json_schema");
  assert.match(JSON.stringify(requests[0]!.body.messages), /Hello world/);
  assert.match(JSON.stringify(requests[0]!.body.messages), /French/);
  assert.deepEqual(mod.ai.aliases.fast, ["vertex:google/gemini-2.5-flash"]);
});
