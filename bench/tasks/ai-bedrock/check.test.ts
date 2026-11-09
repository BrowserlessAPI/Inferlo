import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("summarize calls Claude on Bedrock in eu-central-1 with signed requests; embedText uses Titan", async () => {
  const source = readFileSync(new URL("../src/lib/summarize.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/ai/, "imports the standalone AI entry point");
  assert.doesNotMatch(source, /createApp|aiSdk|openaiCompatible|@aws-sdk/, "uses the built-in adapter");

  process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  process.env.AWS_SESSION_TOKEN = "session-token-1";
  const requests: { url: string; body: any; headers: Headers }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    if (String(url).includes("titan")) return Response.json({ embedding: [0.1, 0.2, 0.3], inputTextTokenCount: 3 });
    return Response.json({ output: { message: { role: "assistant", content: [{ text: '{"summary":"Short.","keywords":["inferlo"]}' }] } }, usage: { inputTokens: 10, outputTokens: 5 } });
  }) as typeof fetch;

  const mod = await import("../src/lib/summarize.ts");
  assert.deepEqual(await mod.summarize("Inferlo is a backend framework.", "user-1"), { summary: "Short.", keywords: ["inferlo"] });
  assert.equal(requests[0]!.url, "https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse");
  assert.match(requests[0]!.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/bedrock\/aws4_request/);
  assert.equal(requests[0]!.headers.get("x-amz-security-token"), "session-token-1");
  assert.match(JSON.stringify(requests[0]!.body.messages), /backend framework/);
  assert.deepEqual(await mod.embedText("hello"), [0.1, 0.2, 0.3]);
  assert.equal(requests[1]!.url, "https://bedrock-runtime.eu-central-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke");
  assert.deepEqual(mod.ai.aliases.fast, ["bedrock:eu.anthropic.claude-haiku-4-5-20251001-v1:0"]);
});
