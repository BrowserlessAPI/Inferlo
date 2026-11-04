import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

test("aiModule provides the AI client to a Nest app under AI_TOKEN", async () => {
  const source = readFileSync(new URL("../src/nest.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/nestjs/, "uses the NestJS entry point");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: any[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init!.body)));
    return Response.json({ content: [{ type: "text", text: "pong" }], usage: { input_tokens: 1, output_tokens: 1 } });
  }) as typeof fetch;

  const { aiModule, AI_TOKEN } = await import("../src/nest.ts");
  class FeatureModule {}
  Module({})(FeatureModule);
  class AppModule {}
  Module({ imports: [aiModule, FeatureModule] })(AppModule);
  const nest = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const ai = nest.select(FeatureModule).get(AI_TOKEN, { strict: false }) as { generate(o: object): Promise<{ text: string }> };
    assert.equal((await ai.generate({ model: "fast", prompt: "ping" })).text, "pong");
    assert.equal(requests[0].model, "claude-haiku-4-5");
  } finally {
    await nest.close();
  }
});
