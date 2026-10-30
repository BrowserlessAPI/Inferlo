import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anthropic, createAI, createApp, KairoError, mockProvider, openai, route, t, type Usage } from "../src/index.ts";
import { readEvents, readJson } from "../src/testing.ts";

const Triage = t.object({ priority: t.enum(["low", "urgent"]), summary: t.string().max(50) });

describe("ai", () => {
  test("text generation through an alias with usage tracking and pricing", async () => {
    const usage: Usage[] = [];
    const ai = createAI({
      providers: { mock: mockProvider({ respond: () => "hello there" }) },
      models: { fast: "mock:m1" },
      pricing: { "mock:m1": { input: 1, output: 2 } },
      onUsage: (u) => void usage.push(u),
    });
    const r = await ai.generate({ model: "fast", prompt: "hi", for: "user-1" });
    assert.equal(r.text, "hello there");
    assert.equal(r.usage.model, "mock:m1");
    assert.equal(usage[0]!.for, "user-1");
    assert.ok(usage[0]!.cost > 0);
  });

  test("structured output is parsed, validated and typed", async () => {
    const ai = createAI({ providers: { mock: mockProvider({ respond: () => '```json\n{"priority":"urgent","summary":"Server down"}\n```' }) }, models: { fast: "mock:x" } });
    const { object } = await ai.generate({ model: "fast", prompt: "triage", output: Triage });
    assert.deepEqual(object, { priority: "urgent", summary: "Server down" });
  });

  test("invalid structured output is repaired once, then fails with KR5002", async () => {
    let calls = 0;
    const flaky = mockProvider({ respond: () => (++calls === 1 ? '{"priority":"meh","summary":"x"}' : '{"priority":"low","summary":"fixed"}') });
    const ai = createAI({ providers: { mock: flaky }, models: { fast: "mock:x" } });
    const { object } = await ai.generate({ model: "fast", prompt: "p", output: Triage });
    assert.equal(object.summary, "fixed");
    assert.match(flaky.calls[1]!.messages.at(-1)!.content, /does not match the schema/);

    const broken = createAI({ providers: { mock: mockProvider({ respond: () => "not json" }) }, models: { fast: "mock:x" } });
    await assert.rejects(broken.generate({ model: "fast", prompt: "p", output: Triage }), (e: unknown) => e instanceof KairoError && e.code === "KR5002");
  });

  test("falls back to the next model on provider errors", async () => {
    const failing = openai({ apiKey: "k", fetch: async () => new Response("overloaded", { status: 529 }) });
    const ai = createAI({ providers: { openai: failing, mock: mockProvider({ respond: () => "from fallback" }) }, models: { fast: ["openai:gpt", "mock:m"] } });
    const r = await ai.generate({ model: "fast", prompt: "x" });
    assert.equal(r.text, "from fallback");
    assert.equal(r.usage.model, "mock:m");
  });

  test("does not fall back on auth errors", async () => {
    const failing = openai({ apiKey: "bad", fetch: async () => new Response("unauthorized", { status: 401 }) });
    const ai = createAI({ providers: { openai: failing, mock: mockProvider({ respond: () => "x" }) }, models: { fast: ["openai:gpt", "mock:m"] } });
    await assert.rejects(ai.generate({ model: "fast", prompt: "x" }), /KR5006|401/);
  });

  test("budgets block calls with KR5004", async () => {
    const ai = createAI({ providers: { mock: mockProvider({ respond: () => "x" }) }, models: { fast: "mock:m" }, allow: ({ for: who }) => who !== "broke" });
    await ai.generate({ model: "fast", prompt: "x", for: "rich" });
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", for: "broke" }), (e: unknown) => e instanceof KairoError && e.code === "KR5004" && e.status === 402);
  });

  test("helpful errors for unknown aliases and providers", async () => {
    const ai = createAI({ providers: { mock: mockProvider({ respond: () => "x" }) }, models: { fast: "mock:m" } });
    await assert.rejects(ai.generate({ model: "fsat", prompt: "x" }), /Did you mean "fast"/);
    await assert.rejects(ai.generate({ model: "openai:gpt", prompt: "x" }), /provider "openai" is not configured/);
    await assert.rejects(createAI().generate({ prompt: "x" }), /KR5001|No AI providers/);
  });

  test("streaming yields chunks and builds an SSE response", async () => {
    const ai = createAI({ providers: { mock: mockProvider({ respond: () => "streaming works well" }) }, models: { fast: "mock:m" } });
    let text = "";
    for await (const chunk of ai.stream({ model: "fast", prompt: "x" })) text += chunk;
    assert.equal(text, "streaming works well");
    const events = await readEvents(ai.stream({ model: "fast", prompt: "x" }).toResponse());
    assert.equal(events.map((e) => e.data).filter((d) => typeof d === "string").join(""), "streaming works well");
    assert.equal(events.at(-1)!.event, "done");
    assert.equal(await ai.stream({ model: "fast", prompt: "x" }).text(), "streaming works well");
  });

  test("anthropic provider request and response shape", async () => {
    let sent: any;
    const provider = anthropic({
      apiKey: "sk-test",
      fetch: async (url, init) => {
        sent = { url: String(url), headers: init?.headers, body: JSON.parse(String(init?.body)) };
        return Response.json({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 2 } });
      },
    });
    const ai = createAI({ providers: { anthropic: provider }, models: { fast: "anthropic:claude-haiku-4-5" } });
    const r = await ai.generate({ model: "fast", system: "be brief", prompt: "hello", maxTokens: 50 });
    assert.equal(r.text, "hi");
    assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
    assert.equal(sent.headers["x-api-key"], "sk-test");
    assert.equal(sent.body.system, "be brief");
    assert.deepEqual(sent.body.messages, [{ role: "user", content: "hello" }]);
    assert.equal(r.usage.inputTokens, 5);
  });

  test("openai streaming parser", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ];
    const provider = openai({
      apiKey: "k",
      fetch: async () =>
        new Response(new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); } }), { headers: { "content-type": "text/event-stream" } }),
    });
    const ai = createAI({ providers: { openai: provider }, models: { fast: "openai:gpt" } });
    const s = ai.stream({ model: "fast", prompt: "x" });
    assert.equal(await s.text(), "Hello");
    assert.equal((await s.usage()).outputTokens, 2);
  });

  test("ctx.ai inside a route", async () => {
    const app = createApp({
      ai: { providers: { mock: mockProvider({ respond: () => '{"priority":"low","summary":"ok"}' }) }, models: { fast: "mock:m" } },
      routes: [
        route.post("/triage", { auth: "public", body: t.object({ text: t.string() }) }).handle(async ({ ai, body }) => (await ai.generate({ model: "fast", prompt: body.text, output: Triage })).object),
      ],
    });
    assert.deepEqual(await readJson(await app.request("/triage", { method: "POST", json: { text: "hi" } }), 200), { priority: "low", summary: "ok" });
  });

  test("embeddings", async () => {
    const ai = createAI({ providers: { mock: mockProvider({ respond: () => "" }) }, models: { embed: "mock:e" } });
    const { embeddings } = await ai.embed({ input: ["a", "b"] });
    assert.equal(embeddings.length, 2);
  });
});
