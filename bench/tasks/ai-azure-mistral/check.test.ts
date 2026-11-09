import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("summarize uses the Azure OpenAI deployment and falls back to Mistral", async () => {
  const source = readFileSync(new URL("../src/lib/summarize.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/ai/, "imports the standalone AI entry point");
  assert.doesNotMatch(source, /createApp|aiSdk|openaiCompatible/, "uses the built-in adapters");

  process.env.AZURE_OPENAI_API_KEY = "azure-key";
  process.env.MISTRAL_API_KEY = "mistral-key";
  let azureUp = true;
  const requests: { url: string; body: any; headers: Headers }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    if (String(url).includes("azure.com") && !azureUp) return new Response("overloaded", { status: 503 });
    const who = String(url).includes("azure.com") ? "Azure" : "Mistral";
    return Response.json({ choices: [{ message: { content: `${who} summary.` } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  }) as typeof fetch;

  const mod = await import("../src/lib/summarize.ts");
  assert.equal(await mod.summarize("A long ticket about invoices.", "user-1"), "Azure summary.");
  assert.equal(requests[0]!.url, "https://contoso-eu.openai.azure.com/openai/v1/chat/completions");
  assert.equal(requests[0]!.headers.get("api-key"), "azure-key");
  assert.equal(requests[0]!.body.model, "gpt-5-mini-prod");
  assert.match(JSON.stringify(requests[0]!.body.messages), /A long ticket about invoices/);

  azureUp = false;
  assert.equal(await mod.summarize("Another ticket.", "user-1"), "Mistral summary.");
  const last = requests.at(-1)!;
  assert.equal(last.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(last.headers.get("authorization"), "Bearer mistral-key");
  assert.equal(last.body.model, "mistral-small-latest");
  assert.deepEqual(mod.ai.aliases.fast, ["azure:gpt-5-mini-prod", "mistral:mistral-small-latest"]);
});
