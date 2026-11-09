import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider, type Usage } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as faq from "../src/routes/faq.ts";

test("identical questions reuse the cached answer for an hour, and the faq tag removes it", async () => {
  const usage: Usage[] = [];
  const provider = mockProvider({ respond: (r) => `Answer: ${r.messages.at(-1)!.content}` });
  const app = createApp({ models, routes: [faq], db: memory(), auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  assert.deepEqual(await readJson(await app.request("/faq?q=refunds", { as: asA }), 200), { answer: "Answer: refunds" });
  assert.deepEqual(await readJson(await app.request("/faq?q=refunds", { as: asA }), 200), { answer: "Answer: refunds" });
  assert.equal(provider.calls.length, 1, "the second identical question is answered from the cache");
  assert.equal(usage.length, 2);
  assert.equal(usage[1]!.cached, true);
  assert.equal(usage[0]!.for, a.id);
  await readJson(await app.request("/faq?q=invoices", { as: asA }), 200);
  assert.equal(provider.calls.length, 2, "another question calls the model");
  await app.cache.invalidate("faq");
  await readJson(await app.request("/faq?q=refunds", { as: asA }), 200);
  assert.equal(provider.calls.length, 3, "the faq tag removes cached answers");
  assert.equal((await app.request("/faq?q=", { as: asA })).status, 422);
  assert.equal((await app.request("/faq?q=x")).status, 401);
});
