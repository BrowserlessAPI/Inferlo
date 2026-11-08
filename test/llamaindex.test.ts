import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { LLMAgent } from "@llamaindex/core/agent";
import { BaseEmbedding } from "@llamaindex/core/embeddings";
import { ToolCallLLM, type ChatMessage, type ToolCallLLMMessageOptions } from "@llamaindex/core/llms";
import { createAI, createApp, InferloError, mockProvider, route, t, tool, type ProviderRequest } from "../src/index.ts";
import { InferloEmbedding, InferloLLM, toLlamaIndexEmbedding, toLlamaIndexLLM, toLlamaIndexTools } from "../src/llamaindex.ts";
import { readJson } from "../src/testing.ts";

const getWeather = tool("getWeather", { description: "Weather in a city", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city, sky: "sunny" }));

function weatherAI(usages: unknown[] = []) {
  const provider = mockProvider({
    respond: (r) =>
      r.messages.at(-1)!.role === "tool"
        ? `Done: ${r.messages.at(-1)!.content}`
        : r.tools?.length
          ? { toolCalls: [{ id: "call_1", name: r.tools[0]!.name, input: { city: "Oslo" } }] }
          : `You said: ${r.messages.at(-1)!.content}`,
  });
  return { provider, ai: createAI({ providers: { mock: provider }, models: { fast: "mock:m", embed: "mock:e" }, onUsage: (u) => void usages.push(u) }) };
}

describe("toLlamaIndexLLM()", () => {
  test("is a LlamaIndex tool-calling LLM, and chat sends messages through the alias with usage", async () => {
    const usages: { model: string; for?: string }[] = [];
    const { ai, provider } = weatherAI(usages);
    const llm = toLlamaIndexLLM(ai, { model: "fast", for: "user-1", temperature: 0.1, maxTokens: 30 });
    assert.ok(llm instanceof InferloLLM);
    assert.ok(llm instanceof ToolCallLLM);
    assert.equal(llm.supportToolCall, true);
    assert.equal(llm.metadata.model, "fast");
    assert.equal(llm.metadata.maxTokens, 30);
    const answer = await llm.chat({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Hi" }] });
    assert.equal(answer.message.role, "assistant");
    assert.equal(answer.message.content, "You said: Hi");
    assert.ok((answer.raw as { usage: { inputTokens: number } }).usage.inputTokens > 0);
    const sent = provider.calls[0] as ProviderRequest;
    assert.deepEqual(sent.messages.map((m) => [m.role, m.content]), [["system", "Be brief."], ["user", "Hi"]]);
    assert.equal(sent.temperature, 0.1);
    assert.equal(sent.maxTokens, 30);
    assert.equal(usages[0]?.model, "mock:m");
    assert.equal(usages[0]?.for, "user-1");
  });

  test("complete and streaming chat and complete", async () => {
    const { ai } = weatherAI();
    const llm = toLlamaIndexLLM(ai, { model: "fast" });
    assert.equal((await llm.complete({ prompt: "Hello" })).text, "You said: Hello");
    let text = "";
    let usage = 0;
    for await (const chunk of await llm.chat({ messages: [{ role: "user", content: "Hello there" }], stream: true })) {
      text += chunk.delta;
      usage += (chunk.raw as { usage?: { outputTokens: number } } | null)?.usage?.outputTokens ?? 0;
    }
    assert.equal(text, "You said: Hello there");
    assert.ok(usage > 0, "the last chunk carries the usage");
    let completed = "";
    for await (const chunk of await llm.complete({ prompt: "Streamed", stream: true })) completed += chunk.text;
    assert.equal(completed, "You said: Streamed");
  });

  test("tools: the model's tool calls come back in options.toolCall and tool results go back to the model", async () => {
    const { ai, provider } = weatherAI();
    const llm = toLlamaIndexLLM(ai, { model: "fast" });
    const tools = [{ metadata: { name: "forecast", description: "Forecast for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
    const first = await llm.chat({ messages: [{ role: "user", content: "Weather in Oslo?" }], tools });
    assert.deepEqual((first.message.options as { toolCall: unknown }).toolCall, [{ id: "call_1", name: "forecast", input: { city: "Oslo" } }]);
    const spec = (provider.calls[0] as ProviderRequest).tools![0]!;
    assert.equal(spec.name, "forecast");
    assert.deepEqual((spec.inputSchema as { required?: string[] }).required, ["city"]);
    const history: ChatMessage<ToolCallLLMMessageOptions>[] = [
      { role: "user", content: "Weather in Oslo?" },
      first.message,
      { role: "user", content: "Rain in Oslo", options: { toolResult: { id: "call_1", result: "Rain in Oslo", isError: false } } },
    ];
    const second = await llm.chat({ messages: history, tools });
    assert.equal(second.message.content, "Done: Rain in Oslo");
    const sent = (provider.calls[1] as ProviderRequest).messages;
    assert.deepEqual(sent[1]!.toolCalls, [{ id: "call_1", name: "forecast", input: { city: "Oslo" } }]);
    assert.equal(sent[2]!.role, "tool");
    assert.equal(sent[2]!.toolCallId, "call_1");
    // A streamed call with tools yields the answer and its tool calls as one chunk.
    const chunks = [];
    for await (const chunk of await llm.chat({ messages: [{ role: "user", content: "Weather?" }], tools, stream: true })) chunks.push(chunk);
    assert.equal(chunks.length, 1);
    assert.deepEqual((chunks[0]!.options as { toolCall: unknown }).toolCall, [{ id: "call_1", name: "forecast", input: { city: "Oslo" } }]);
  });

  test("images in user messages reach vision models; other content and responseFormat raise IL5037", async () => {
    const { ai, provider } = weatherAI();
    const llm = toLlamaIndexLLM(ai);
    await llm.chat({
      messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } as never] }],
    });
    assert.deepEqual((provider.calls[0] as ProviderRequest).messages[0]!.images, [{ url: "https://example.com/a.png" }, { base64: "iVBORw0KGgo=", mediaType: "image/png" }]);
    const il5037 = (e: unknown) => e instanceof InferloError && e.code === "IL5037";
    await assert.rejects(llm.chat({ messages: [{ role: "user", content: [{ type: "audio", data: "x", mimeType: "audio/wav" } as never] }] }), il5037);
    await assert.rejects(llm.chat({ messages: [{ role: "user", content: "x" }], responseFormat: { type: "object" } }), il5037);
    await assert.rejects(llm.complete({ prompt: "x", responseFormat: { type: "object" } }), il5037);
  });

  test("runs a LlamaIndex agent (LLMAgent) that calls an Inferlo function tool", async () => {
    const { ai, provider } = weatherAI();
    const agent = new LLMAgent({ llm: toLlamaIndexLLM(ai, { model: "fast" }), tools: toLlamaIndexTools([getWeather]) });
    const response = await agent.chat({ message: "Weather in Oslo?" });
    assert.match(String(response.message.content), /^Done: .*"sky":"sunny"/);
    assert.equal((provider.calls[0] as ProviderRequest).tools![0]!.name, "getWeather");
    const streamed = await agent.chat({ message: "Weather in Oslo again?", stream: true });
    let text = "";
    // A ReadableStream of chunks in newer releases, an async iterable in older ones.
    for await (const chunk of streamed as unknown as AsyncIterable<{ delta: string }>) text += chunk.delta;
    assert.match(text, /^Done: .*"sky":"sunny"/);
  });

  test("invalid arguments raise IL5037", () => {
    const { ai } = weatherAI();
    const il5037 = (e: unknown) => e instanceof InferloError && e.code === "IL5037";
    assert.throws(() => toLlamaIndexLLM(undefined as never), il5037);
    assert.throws(() => toLlamaIndexLLM({} as never), il5037);
    assert.throws(() => toLlamaIndexLLM(ai, { stream: true } as never), il5037);
    assert.throws(() => toLlamaIndexLLM(ai, null as never), il5037);
    assert.throws(() => toLlamaIndexEmbedding(undefined as never), il5037);
    assert.throws(() => toLlamaIndexEmbedding(ai, { batchSize: 0 }), il5037);
    assert.throws(() => toLlamaIndexEmbedding(ai, { dimensions: 3 } as never), il5037);
    assert.throws(() => toLlamaIndexTools("x" as never), il5037);
    assert.throws(() => toLlamaIndexTools([{}] as never), il5037);
  });
});

describe("toLlamaIndexEmbedding()", () => {
  test("is a LlamaIndex embedding model that embeds texts in batches through the alias", async () => {
    const usages: { model: string; kind?: string; for?: string }[] = [];
    const { ai } = weatherAI(usages);
    const embed = toLlamaIndexEmbedding(ai, { model: "embed", for: "tenant-1", batchSize: 2 });
    assert.ok(embed instanceof InferloEmbedding);
    assert.ok(embed instanceof BaseEmbedding);
    assert.equal(embed.embedBatchSize, 2);
    const one = await embed.getTextEmbedding("hello");
    assert.ok(Array.isArray(one) && one.length > 0 && typeof one[0] === "number");
    const many = await embed.getTextEmbeddingsBatch(["a", "b", "c"]);
    assert.equal(many.length, 3);
    assert.deepEqual(await embed.getTextEmbeddings([]), []);
    assert.ok(embed.similarity(one, one) > 0.99);
    assert.equal(usages.length, 3, "one call for the text, then one per batch of two");
    assert.equal(usages[0]?.for, "tenant-1");
    assert.equal(usages[0]?.model, "mock:e");
  });
});

describe("toLlamaIndexTools()", () => {
  test("function tools become LlamaIndex tools with Inferlo's validation", async () => {
    const [weather] = toLlamaIndexTools([getWeather]);
    assert.equal(weather!.metadata.name, "getWeather");
    assert.equal(weather!.metadata.description, "Weather in a city");
    assert.deepEqual((weather!.metadata.parameters as { required?: string[] }).required, ["city"]);
    assert.deepEqual(JSON.parse(String(await weather!.call({ city: "Oslo" }))), { city: "Oslo", sky: "sunny" });
    assert.match(String(await weather!.call({ town: "Oslo" })), /IL1001|city/);
    assert.throws(() => toLlamaIndexTools([getWeather, getWeather]), (e: unknown) => e instanceof InferloError && e.code === "IL5013");
  });

  test("routes run as the signed-in user with the request's ctx.ai, and need it (IL5009)", async () => {
    const createTicket = route
      .post("/tickets", { body: t.object({ title: t.string().min(1) }), tool: true, description: "Open a ticket" })
      .handle(({ body, user }) => ({ title: body.title, ownerId: user.id }));
    assert.throws(() => toLlamaIndexTools([createTicket]), (e: unknown) => e instanceof InferloError && e.code === "IL5009");
    const ask = route.post("/ask", { body: t.object({ title: t.string() }) }).handle(async ({ ai, body }) => {
      const [ticket] = toLlamaIndexTools([createTicket], { ai });
      return { name: ticket!.metadata.name, result: JSON.parse(String(await ticket!.call({ title: body.title }))) };
    });
    const app = createApp({
      routes: [{ createTicket, ask }],
      auth: { resolve: () => ({ id: "00000000-0000-4000-8000-000000000009", roles: [] }) },
      ai: { providers: { mock: mockProvider({ respond: () => "" }) }, models: { fast: "mock:m" } },
    });
    const body = await readJson(await app.request("/ask", { method: "POST", json: { title: "Broken" }, headers: { authorization: "Bearer x" } }), 200);
    assert.deepEqual(body, { name: "createTicket", result: { title: "Broken", ownerId: "00000000-0000-4000-8000-000000000009" } });
  });

  test("the core package never imports LlamaIndex", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.equal(index.includes("llamaindex"), false);
  });
});
