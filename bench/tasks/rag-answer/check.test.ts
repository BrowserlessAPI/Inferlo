import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as documents from "../src/routes/documents.ts";

test("documents are chunked, embedded and answered from, per user", async () => {
  const usage: { for?: string; kind: string }[] = [];
  const answerer = mockProvider({
    respond: (r) => {
      const system = r.messages.find((m) => m.role === "system")?.content ?? "";
      return system.includes("Refunds take five business days.") ? "Five business days." : "I do not know.";
    },
  });
  const app = createApp({
    models,
    routes: [documents],
    db: memory(),
    auth: { resolve: () => null },
    ai: { providers: { mock: mockProvider({ respond: () => "" }), answer: answerer }, models: { embed: "mock:e", fast: "answer:a" }, onUsage: (u) => void usage.push(u) },
  });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const b = await app.db.users.insert({ email: "b@x.io", name: "B" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const asB = { id: b.id, email: b.email, name: b.name, roles: [] };
  const long = Array.from({ length: 400 }, (_, i) => `Policy line ${i} explains a rule.`).join(" ");
  const policy = await readJson(await app.request("/documents", { method: "POST", json: { text: long }, as: asA }), 201);
  assert.ok(policy.chunks > 1, "long text is split into several chunks");
  const stored = await readJson(await app.request("/documents", { method: "POST", json: { text: "Refunds take five business days." }, as: asA }), 201);
  assert.match(stored.documentId, /^[0-9a-f-]{36}$/);
  assert.notEqual(stored.documentId, policy.documentId);
  assert.equal(stored.chunks, 1);
  assert.ok(usage.some((u) => u.kind === "embed" && u.for === a.id));

  const out = await readJson(await app.request("/ask", { method: "POST", json: { question: "Refunds take five business days." }, as: asA }), 200);
  assert.equal(out.answer, "Five business days.");
  assert.equal(out.sources[0], stored.documentId, "the closest chunk's document comes first");
  assert.equal(new Set(out.sources).size, out.sources.length, "sources are distinct");
  assert.ok(usage.some((u) => u.kind === "generate" && u.for === a.id));

  const other = await readJson(await app.request("/ask", { method: "POST", json: { question: "Refunds take five business days." }, as: asB }), 200);
  assert.deepEqual(other, { answer: "I do not know.", sources: [] });
  assert.equal((await app.request("/ask", { method: "POST", json: { question: "" }, as: asA })).status, 422);
  assert.equal((await app.request("/documents", { method: "POST", json: { text: "x" } })).status, 401);
});
