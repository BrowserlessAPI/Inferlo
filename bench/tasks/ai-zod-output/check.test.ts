import assert from "node:assert/strict";
import { test } from "node:test";
import { createAI, mockProvider } from "@browserlessapi/inferlo/ai";
import { triage, triageSchema } from "../src/triage.ts";

test("triage with a Zod schema", async () => {
  assert.equal((triageSchema as unknown as { "~standard": { vendor: string } })["~standard"].vendor, "zod", "triageSchema is a Zod schema");
  const provider = mockProvider({ respond: () => '{"priority":"urgent","tags":["billing","refund"]}' });
  const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
  const result = await triage(ai, "I was charged twice, please refund");
  assert.deepEqual(result, { priority: "urgent", tags: ["billing", "refund"] });
  const request = provider.calls[0]!;
  assert.equal(request.model, "m", "uses the fast alias");
  const schema = request.jsonSchema as { properties?: Record<string, { enum?: string[] }> };
  assert.deepEqual(schema.properties?.priority?.enum, ["low", "normal", "urgent"], "the model is shown the Zod schema");
  assert.ok(request.messages.some((m) => m.content.includes("charged twice")));

  const wrong = createAI({ providers: { mock: mockProvider({ respond: () => '{"priority":"asap","tags":[]}' }) }, models: { fast: "mock:m" } });
  await assert.rejects(triage(wrong, "x"), (e: unknown) => (e as { code?: string }).code === "IL5002", "answers that do not match the Zod schema are refused");
});
