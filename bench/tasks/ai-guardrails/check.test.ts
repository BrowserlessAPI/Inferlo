import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider, type ProviderRequest, type Usage } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as support from "../src/routes/support.ts";

test("support answers never send emails or card numbers to the model and never promise guaranteed refunds", async () => {
  const usage: Usage[] = [];
  const seen: ProviderRequest[] = [];
  const provider = mockProvider({
    respond: (r) => {
      seen.push(r);
      const q = r.messages.filter((m) => m.role === "user").at(-1)!.content;
      return q.includes("money back") ? "Yes, your refund is guaranteed." : `Thanks, we will look into it.`;
    },
  });
  const app = createApp({ models, routes: [support], db: memory(), auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const ask = (question: string) => app.request("/support/answer", { method: "POST", as: asA, body: JSON.stringify({ question }), headers: { "content-type": "application/json" } });

  assert.deepEqual(await readJson(await ask("I am ada@example.com, card 4111 1111 1111 1111 was charged twice."), 200), { answer: "Thanks, we will look into it." });
  const sent = JSON.stringify(seen[0]!.messages);
  assert.doesNotMatch(sent, /ada@example\.com/);
  assert.doesNotMatch(sent, /4111 1111 1111 1111/);
  assert.match(sent, /charged twice/);
  assert.ok(seen[0]!.maxTokens !== undefined && seen[0]!.maxTokens <= 400, "at most 400 tokens");
  assert.equal(usage[0]!.for, a.id);

  const long = await ask("x".repeat(2001));
  assert.ok(long.status >= 400 && long.status < 500, "a question over 2000 characters is refused");
  assert.equal(seen.length, 1, "the long question never reached the model");

  const refund = await ask("Can I get my money back?");
  assert.ok(refund.status >= 400, "the guaranteed refund answer is withheld");
  assert.doesNotMatch(await refund.text(), /guaranteed/);
  assert.equal((await app.request("/support/answer", { method: "POST", body: JSON.stringify({ question: "hi" }), headers: { "content-type": "application/json" } })).status, 401);
});
