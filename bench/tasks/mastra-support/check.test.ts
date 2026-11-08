import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, mockProvider, type ProviderRequest, type Usage } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as supportRoutes from "../src/routes/support.ts";

test("POST /support answers through a Mastra agent on ctx.ai, with an Inferlo tool", async () => {
  const source = readFileSync(new URL("../src/routes/support.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/mastra/, "uses Inferlo's Mastra integration");
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes\/support/, "registers the route module");
  const provider = mockProvider({
    respond: (r) => {
      const last = r.messages.at(-1)!;
      if (last.role === "tool") return `Your order is ${JSON.parse(last.content).status}`;
      const tool = r.tools?.find((x) => x.name === "orderStatus");
      return tool ? { toolCalls: [{ id: "c1", name: "orderStatus", input: { orderId: "A-1" } }] } : `Echo: ${last.content}`;
    },
  });
  const usages: Usage[] = [];
  const app = createApp({ models, routes: [supportRoutes], db: memory(), auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usages.push(u) } });
  const user = { id: "11111111-1111-4111-8111-111111111111", email: "a@x.io", name: "A", roles: [] };
  const body = await readJson(await app.request("/support", { method: "POST", json: { question: "Where is order A-1?" }, as: user }), 200);
  assert.deepEqual(body, { answer: "Your order is shipped" });
  const sent = provider.calls[0] as ProviderRequest;
  assert.match(sent.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"), /You answer support questions\./);
  assert.equal(sent.messages.filter((m) => m.role === "user").at(-1)?.content, "Where is order A-1?");
  assert.equal(sent.tools?.[0]?.description, "Status of an order");
  assert.equal(usages[0]?.for, user.id, "usage is tracked for the user");
  assert.equal(usages[0]?.requested, "fast");
  await readJson(await app.request("/support", { method: "POST", json: { question: "x".repeat(4001) }, as: user }), 422);
});
