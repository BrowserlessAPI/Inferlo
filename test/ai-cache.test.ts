import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAI, createApp, InferloError, mockProvider, route, t, tool, type Usage } from "../src/index.ts";
import { readJson } from "../src/testing.ts";

// ai.generate({ cache: { ttlMs, tags } }): identical calls reuse the earlier answer instead of calling the model.

const counting = (reply: (prompt: string) => string = (p) => `Answer to ${p}`) =>
  mockProvider({ respond: (r) => reply(r.messages.filter((m) => m.role === "user").at(-1)!.content) });

describe("ai.generate({ cache })", () => {
  test("an identical call within ttlMs reuses the answer: no model call, usage says cached with zero tokens and cost", async () => {
    const usage: Usage[] = [];
    const provider = counting();
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, pricing: { "m:x": { input: 1, output: 1 } }, onUsage: (u) => void usage.push(u) });
    const first = await ai.generate({ model: "fast", prompt: "What is Inferlo?", cache: { ttlMs: 60_000 }, for: "ann" });
    const second = await ai.generate({ model: "fast", prompt: "What is Inferlo?", cache: { ttlMs: 60_000 }, for: "ben" });
    assert.equal(provider.calls.length, 1);
    assert.equal(second.text, first.text);
    assert.equal(first.cached, undefined);
    assert.equal(second.cached, true);
    assert.deepEqual(second.steps, []);
    assert.equal(usage.length, 2);
    assert.ok(usage[0]!.inputTokens > 0 && usage[0]!.cost > 0);
    assert.deepEqual([usage[1]!.cached, usage[1]!.inputTokens, usage[1]!.outputTokens, usage[1]!.cost, usage[1]!.model, usage[1]!.for], [true, 0, 0, 0, "m:x", "ben"]);
  });

  test("a different prompt, system message, model, temperature, maxTokens or output schema is a different entry; calls without cache never use it", async () => {
    const provider = counting();
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x", smart: "m:y" } });
    const cache = { ttlMs: 60_000 };
    await ai.generate({ model: "fast", prompt: "A", cache });
    await ai.generate({ model: "fast", prompt: "B", cache });
    await ai.generate({ model: "fast", system: "Be short.", prompt: "A", cache });
    await ai.generate({ model: "smart", prompt: "A", cache });
    await ai.generate({ model: "fast", prompt: "A", temperature: 0, cache });
    await ai.generate({ model: "fast", prompt: "A", maxTokens: 10, cache });
    await ai.generate({ model: "fast", prompt: "A" });
    assert.equal(provider.calls.length, 7);
    await ai.generate({ model: "fast", prompt: "A", cache });
    assert.equal(provider.calls.length, 7);
  });

  test("structured output is cached and validated again on a hit", async () => {
    const provider = mockProvider({ respond: () => JSON.stringify({ label: "bug", score: 3, at: "2026-11-09T10:00:00.000Z" }) });
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" } });
    const Out = t.object({ label: t.enum(["bug", "question"]), score: t.int(), at: t.date() });
    const first = await ai.generate({ model: "fast", prompt: "Classify", output: Out, cache: { ttlMs: 60_000 } });
    const second = await ai.generate({ model: "fast", prompt: "Classify", output: Out, cache: { ttlMs: 60_000 } });
    assert.equal(provider.calls.length, 1);
    assert.equal(second.cached, true);
    assert.ok(second.object.at instanceof Date);
    assert.deepEqual(second.object, first.object);
    // Another output schema is another entry.
    await ai.generate({ model: "fast", prompt: "Classify", output: t.object({ label: t.string() }).strip(), cache: { ttlMs: 60_000 } });
    assert.equal(provider.calls.length, 2);
  });

  test("entries expire after ttlMs, and failed calls are not cached", async () => {
    let fail = true;
    const provider = mockProvider({
      respond: () => {
        if (fail) throw new Error("down");
        return "ok";
      },
    });
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" } });
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", cache: { ttlMs: 30 } }));
    fail = false;
    assert.equal((await ai.generate({ model: "fast", prompt: "x", cache: { ttlMs: 30 } })).cached, undefined);
    assert.equal((await ai.generate({ model: "fast", prompt: "x", cache: { ttlMs: 30 } })).cached, true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await ai.generate({ model: "fast", prompt: "x", cache: { ttlMs: 30 } })).cached, undefined);
  });

  test("invalid options and tools raise IL5040; budgets still apply to cached calls", async () => {
    const ai = createAI({ providers: { m: counting() }, models: { fast: "m:x" }, allow: ({ for: who }) => who !== "blocked" });
    const code = (e: InferloError) => e.code === "IL5040";
    for (const cache of [{}, { ttlMs: 0 }, { ttlMs: 1.5 }, { ttlMs: 1000, tags: [""] }, { ttlMs: 1000, scope: "user" }, "1h"]) {
      await assert.rejects(ai.generate({ model: "fast", prompt: "x", cache: cache as never }), code, JSON.stringify(cache));
    }
    const echo = tool("echo", { description: "Echo", input: t.object({}) }).handle(() => "hi");
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", tools: [echo], cache: { ttlMs: 1000 } }), (e: InferloError) => code(e) && /tools/.test(e.message));
    await ai.generate({ model: "fast", prompt: "y", cache: { ttlMs: 60_000 } });
    await assert.rejects(ai.generate({ model: "fast", prompt: "y", cache: { ttlMs: 60_000 }, for: "blocked" }), (e: InferloError) => e.code === "IL5004");
  });

  test("in an app, answers are kept in the app's cache and tags invalidate them", async () => {
    const provider = counting();
    const faq = route.get("/faq", { query: t.object({ q: t.string().max(200) }) }).handle(async ({ ai, query, user }) => {
      const { text, cached } = await ai.generate({ model: "fast", prompt: query.q, cache: { ttlMs: 3_600_000, tags: ["faq"] }, for: user.id });
      return { text, cached: cached ?? false };
    });
    const app = createApp({ routes: [{ faq }], auth: { resolve: () => null }, ai: { providers: { m: provider }, models: { fast: "m:x" } }, logger: { info() {}, error() {} } });
    const as = { id: "ann", roles: [] };
    assert.deepEqual(await readJson(await app.request("/faq?q=refunds", { as }), 200), { text: "Answer to refunds", cached: false });
    assert.deepEqual(await readJson(await app.request("/faq?q=refunds", { as }), 200), { text: "Answer to refunds", cached: true });
    assert.equal((await app.ai.generate({ model: "fast", prompt: "refunds", cache: { ttlMs: 1000 } })).cached, true, "app.ai shares the app's cache");
    await app.cache.invalidate("faq");
    assert.deepEqual(await readJson(await app.request("/faq?q=refunds", { as }), 200), { text: "Answer to refunds", cached: false });
    assert.equal(provider.calls.length, 2);
  });
});
