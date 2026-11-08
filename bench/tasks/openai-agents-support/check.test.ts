import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setTracingDisabled } from "@openai/agents-core";
import { createApp, memory, mockProvider, type ProviderRequest, type Usage } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as supportRoutes from "../src/routes/support.ts";

setTracingDisabled(true);

test("POST /support answers through an Agents SDK agent on ctx.ai", async () => {
  const source = readFileSync(new URL("../src/routes/support.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/openai-agents/, "uses Inferlo's OpenAI Agents SDK integration");
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes\/support/, "registers the route module");
  const provider = mockProvider({ respond: (r) => `Echo: ${r.messages.at(-1)!.content}` });
  const usages: Usage[] = [];
  const app = createApp({ models, routes: [supportRoutes], db: memory(), auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usages.push(u) } });
  const user = { id: "11111111-1111-4111-8111-111111111111", email: "a@x.io", name: "A", roles: [] };
  const body = await readJson(await app.request("/support", { method: "POST", json: { question: "Hello" }, as: user }), 200);
  assert.deepEqual(body, { answer: "Echo: Hello" });
  const sent = provider.calls[0] as ProviderRequest;
  assert.deepEqual(sent.messages.map((m) => [m.role, m.content]), [["system", "You answer support questions."], ["user", "Hello"]]);
  assert.equal(usages[0]?.for, user.id, "usage is tracked for the user");
  assert.equal(usages[0]?.requested, "fast");
  await readJson(await app.request("/support", { method: "POST", json: { question: "x".repeat(4001) }, as: user }), 422);
});
