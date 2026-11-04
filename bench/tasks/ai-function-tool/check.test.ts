import assert from "node:assert/strict";
import { test } from "node:test";
import { createAI, isTool, mockProvider } from "@browserlessapi/inferlo";
import * as assistant from "../src/lib/assistant.ts";

test("checkStock is a function tool the model can call through answer()", async () => {
  assert.ok(isTool(assistant.checkStock), "checkStock is made with tool(...).handle(...)");
  assert.equal(assistant.checkStock.name, "checkStock");

  const mock = mockProvider({
    respond: (r) => {
      const results = r.messages.filter((m) => m.role === "tool");
      if (results.length === 0) return { toolCalls: [{ name: "checkStock", input: { sku: "SKU-1" } }] };
      if (results.length === 1) return { toolCalls: [{ name: "checkStock", input: { sku: "NOPE" } }] };
      return results.map((m) => m.content).join(" | ");
    },
  });
  const ai = createAI({ providers: { mock }, models: { fast: "mock:m" } });
  const text = await assistant.answer(ai, "Is SKU-1 in stock?");
  const [ok, missing] = text.split(" | ");
  assert.deepEqual(JSON.parse(ok!), { sku: "SKU-1", inStock: 12 });
  assert.match(missing!, /Unknown SKU/);
  assert.match(missing!, /HTTP404|404/);
  assert.equal(mock.calls[0]!.messages.find((m) => m.role === "user")!.content, "Is SKU-1 in stock?");
  assert.deepEqual(mock.calls[0]!.tools?.map((s) => s.name), ["checkStock"]);
  const missingMsg = mock.calls[2]!.messages.filter((m) => m.role === "tool")[1]!;
  assert.equal(missingMsg.isError, true);
});

test("answer stops after 3 steps", async () => {
  const looping = mockProvider({ respond: () => ({ toolCalls: [{ name: "checkStock", input: { sku: "SKU-2" } }] }) });
  const ai = createAI({ providers: { looping }, models: { fast: "looping:m" } });
  await assert.rejects(assistant.answer(ai, "loop"), (e: { code?: string }) => e.code === "IL5010");
  assert.equal(looping.calls.length, 3);
});
