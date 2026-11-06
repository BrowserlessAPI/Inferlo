import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, mockProvider, type ProviderRequest, type Usage } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as assistantRoutes from "../src/routes/assistant.ts";

test("POST /assistant answers through a LangChain model made from ctx.ai", async () => {
  const source = readFileSync(new URL("../src/routes/assistant.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/langchain/, "uses Inferlo's LangChain integration");
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes\/assistant/, "registers the route module");
  const provider = mockProvider({ respond: (r) => `Echo: ${r.messages.at(-1)!.content}` });
  const usages: Usage[] = [];
  const app = createApp({ models, routes: [assistantRoutes], db: memory(), auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usages.push(u) } });
  const user = { id: "11111111-1111-4111-8111-111111111111", email: "a@x.io", name: "A", roles: [] };
  const body = await readJson(await app.request("/assistant", { method: "POST", json: { message: "Hello" }, as: user }), 200);
  assert.deepEqual(body, { answer: "Echo: Hello" });
  const sent = provider.calls[0] as ProviderRequest;
  assert.deepEqual(sent.messages.map((m) => [m.role, m.content]), [["system", "You are a helpful assistant."], ["user", "Hello"]]);
  assert.equal(usages[0]?.for, user.id, "usage is tracked for the user");
  assert.equal(usages[0]?.requested, "fast");
  await readJson(await app.request("/assistant", { method: "POST", json: { message: "x".repeat(4001) }, as: user }), 422);
});
