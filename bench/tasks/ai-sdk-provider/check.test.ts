import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Together AI is an AI SDK provider behind the cheap alias", async () => {
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  assert.match(source, /aiSdk\(/, "wraps the provider with aiSdk()");
  assert.match(readFileSync(new URL("../src/config.ts", import.meta.url), "utf8"), /TOGETHER_API_KEY/, "a TOGETHER_API_KEY setting");

  const requests: { url: string; body: { model: string } }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "x", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Bonjour" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  }) as typeof fetch;
  try {
    const { app } = await import("../src/app.ts");
    const aliases = app.describe().ai.aliases;
    assert.deepEqual(aliases.cheap, ["together:meta-llama/Llama-3.3-70B-Instruct-Turbo"]);
    assert.ok(aliases.fast, "the existing aliases stay");
    const result = await app.ai.generate({ model: "cheap", prompt: "Say hello in French" });
    assert.equal(result.text, "Bonjour");
    assert.equal(result.usage.model, "together:meta-llama/Llama-3.3-70B-Instruct-Turbo");
    assert.equal(requests[0]?.url, "https://api.together.xyz/v1/chat/completions");
    assert.equal(requests[0]?.body.model, "meta-llama/Llama-3.3-70B-Instruct-Turbo");
  } finally {
    globalThis.fetch = realFetch;
  }
});
