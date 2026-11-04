import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DITest } from "@tsed/di";

test("aiProviders registers the AI client in Ts.ED under AI_TOKEN", async () => {
  const source = readFileSync(new URL("../src/tsed.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/tsed/, "uses the Ts.ED entry point");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: any[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init!.body)));
    return Response.json({ content: [{ type: "text", text: "pong" }], usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;

  const { aiProviders, AI_TOKEN } = await import("../src/tsed.ts");
  await DITest.create({ imports: aiProviders });
  try {
    const ai = DITest.get(AI_TOKEN) as { generate(o: object): Promise<{ text: string }> };
    assert.equal((await ai.generate({ model: "fast", prompt: "ping" })).text, "pong");
    assert.equal(requests[0].model, "claude-haiku-4-5");
  } finally {
    await DITest.reset();
  }
});
