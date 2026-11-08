import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, mockProvider, type ProviderRequest, type Usage } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as askRoutes from "../src/routes/ask.ts";

test("POST /ask runs generateText on ctx.ai with an Inferlo tool", async () => {
  const source = readFileSync(new URL("../src/routes/ask.ts", import.meta.url), "utf8");
  assert.match(source, /toAISdkModel/, "uses Inferlo's AI SDK model");
  assert.match(source, /generateText/, "uses the AI SDK's generateText");
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes\/ask/, "registers the route module");
  const provider = mockProvider({
    respond: (r) => {
      const last = r.messages.at(-1)!;
      if (last.role === "tool") return `Your order is ${JSON.parse(last.content).status}`;
      return r.tools?.some((x) => x.name === "orderStatus") ? { toolCalls: [{ id: "c1", name: "orderStatus", input: { orderId: "A-1" } }] } : `Echo: ${last.content}`;
    },
  });
  const usages: Usage[] = [];
  const app = createApp({ models, routes: [askRoutes], db: memory(), auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usages.push(u) } });
  const user = { id: "11111111-1111-4111-8111-111111111111", email: "a@x.io", name: "A", roles: [] };
  const body = await readJson(await app.request("/ask", { method: "POST", json: { question: "Where is order A-1?" }, as: user }), 200);
  assert.deepEqual(body, { answer: "Your order is shipped" });
  const sent = provider.calls[0] as ProviderRequest;
  assert.deepEqual(sent.messages.map((m) => [m.role, m.content]), [["system", "You answer support questions."], ["user", "Where is order A-1?"]]);
  assert.equal(sent.tools?.[0]?.description, "Status of an order");
  assert.equal(usages[0]?.for, user.id, "usage is tracked for the user");
  assert.equal(usages[0]?.requested, "fast");
  await readJson(await app.request("/ask", { method: "POST", json: { question: "x".repeat(4001) }, as: user }), 422);
});
