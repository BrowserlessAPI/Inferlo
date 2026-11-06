import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { aiSdk, createAI, InferloError, t, tool, type AISdkProvider, type ProviderError } from "../src/index.ts";

type Call = Record<string, any>;

/** A hand-written AI SDK provider of one specification version (v2 = ai 5, v3 = ai 6, v4 = ai 7). */
function fakeProvider(version: "v2" | "v3" | "v4", reply: (options: Call) => { content: Call[]; fail?: unknown } = () => ({ content: [{ type: "text", text: "Hello" }] })) {
  const calls: Call[] = [];
  const embedCalls: string[][] = [];
  const usage = version === "v2" ? { inputTokens: 7, outputTokens: 3, totalTokens: 10 } : { inputTokens: { total: 7, noCache: 7 }, outputTokens: { total: 3, text: 3 } };
  const model = (modelId: string) => ({
    specificationVersion: version,
    provider: "acme.chat",
    modelId,
    supportedUrls: {},
    async doGenerate(options: Call) {
      calls.push(options);
      const r = reply(options);
      if (r.fail) throw r.fail;
      return { content: r.content, usage, finishReason: "stop", warnings: [] };
    },
    async doStream(options: Call) {
      calls.push(options);
      const parts: Call[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", delta: "Hel" },
        { type: "text-delta", id: "1", delta: "lo" },
        { type: "text-end", id: "1" },
        { type: "finish", usage, finishReason: "stop" },
      ];
      return { stream: new ReadableStream({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) }) };
    },
  });
  const embedding = (modelId: string) => ({
    specificationVersion: version,
    provider: "acme.embedding",
    modelId,
    maxEmbeddingsPerCall: 2,
    supportsParallelCalls: true,
    async doEmbed({ values }: { values: string[] }) {
      embedCalls.push(values);
      return { embeddings: values.map((v) => [v.length, 1]), usage: { tokens: values.length * 2 }, warnings: [] };
    },
  });
  const provider: AISdkProvider = version === "v2" ? { languageModel: model, textEmbeddingModel: embedding } : { specificationVersion: version, languageModel: model, embeddingModel: embedding };
  return { provider, calls, embedCalls };
}

for (const version of ["v2", "v3", "v4"] as const) {
  describe(`aiSdk() with specification ${version}`, () => {
    test("generate, aliases, usage and the provider name", async () => {
      const fake = fakeProvider(version);
      const usages: unknown[] = [];
      const ai = createAI({ providers: { acme: aiSdk(fake.provider) }, models: { fast: "acme:acme-small" }, onUsage: (u) => void usages.push(u) });
      const result = await ai.generate({ model: "fast", system: "Be brief.", prompt: "Hi", temperature: 0.2, maxTokens: 50 });
      assert.equal(result.text, "Hello");
      assert.equal(result.usage.model, "acme:acme-small");
      assert.equal(result.usage.inputTokens, 7);
      assert.equal(result.usage.outputTokens, 3);
      const call = fake.calls[0]!;
      assert.deepEqual(call.prompt, [
        { role: "system", content: "Be brief." },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ]);
      assert.equal(call.temperature, 0.2);
      assert.equal(call.maxOutputTokens, 50);
      assert.equal(usages.length, 1);
      assert.equal(aiSdk(fake.provider, { name: "mine" }).name, "mine");
    });

    test("structured output sends a JSON response format with the schema", async () => {
      const fake = fakeProvider(version, () => ({ content: [{ type: "text", text: '{"priority":"urgent"}' }] }));
      const ai = createAI({ providers: { acme: aiSdk(fake.provider) } });
      const { object } = await ai.generate({ model: "acme:m", prompt: "Classify", output: t.object({ priority: t.enum(["low", "urgent"]) }) });
      assert.deepEqual(object, { priority: "urgent" });
      assert.equal(fake.calls[0]!.responseFormat.type, "json");
      assert.equal(fake.calls[0]!.responseFormat.schema.type, "object");
    });

    test("tool calls run Inferlo tools, and results go back as tool messages", async () => {
      const fake = fakeProvider(version, (options) =>
        options.prompt.some((m: Call) => m.role === "tool")
          ? { content: [{ type: "text", text: "It is sunny." }] }
          : { content: [{ type: "tool-call", toolCallId: "c1", toolName: "getWeather", input: '{"city":"Oslo"}' }] },
      );
      const getWeather = tool("getWeather", { description: "Weather in a city", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city, sky: "sunny" }));
      const ai = createAI({ providers: { acme: aiSdk(fake.provider) } });
      const result = await ai.generate({ model: "acme:m", prompt: "Weather in Oslo?", tools: [getWeather] });
      assert.equal(result.text, "It is sunny.");
      assert.deepEqual(result.steps[0]?.toolCalls[0]?.input, { city: "Oslo" });
      const first = fake.calls[0]!;
      assert.deepEqual(first.tools[0], { type: "function", name: "getWeather", description: "Weather in a city", inputSchema: first.tools[0].inputSchema });
      assert.equal(first.tools[0].inputSchema.type, "object");
      const second = fake.calls[1]!.prompt as Call[];
      assert.deepEqual(second[1], { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "getWeather", input: { city: "Oslo" } }] });
      assert.equal(second[2]!.role, "tool");
      assert.equal(second[2]!.content[0].toolName, "getWeather");
      assert.equal(second[2]!.content[0].output.type, "text");
      assert.match(second[2]!.content[0].output.value, /sunny/);
    });

    test("images become file parts in the version's shape", async () => {
      const fake = fakeProvider(version);
      const ai = createAI({ providers: { acme: aiSdk(fake.provider) } });
      await ai.generate({ model: "acme:m", prompt: "What is this?", images: [{ base64: "iVBORw0KGgo=", mediaType: "image/png" }, { url: "https://example.com/cat.jpg" }] });
      const [, data, url] = fake.calls[0]!.prompt[0].content;
      if (version === "v2") {
        assert.deepEqual(data, { type: "file", data: "iVBORw0KGgo=", mediaType: "image/png" });
        assert.equal(url.data.href, "https://example.com/cat.jpg");
      } else {
        assert.deepEqual(data, { type: "file", data: { type: "data", data: "iVBORw0KGgo=" }, mediaType: "image/png" });
        assert.equal(url.data.type, "url");
        assert.equal(url.data.url.href, "https://example.com/cat.jpg");
      }
    });

    test("stream yields text and usage", async () => {
      const fake = fakeProvider(version);
      const ai = createAI({ providers: { acme: aiSdk(fake.provider) } });
      const stream = ai.stream({ model: "acme:m", prompt: "Hi" });
      let text = "";
      for await (const chunk of stream) text += chunk;
      assert.equal(text, "Hello");
      assert.equal((await stream.usage()).inputTokens, 7);
    });

    test("embed batches by maxEmbeddingsPerCall and counts tokens", async () => {
      const fake = fakeProvider(version);
      const ai = createAI({ providers: { acme: aiSdk(fake.provider) } });
      const { embeddings, usage } = await ai.embed({ model: "acme:embed", input: ["a", "bb", "ccc"] });
      assert.deepEqual(embeddings, [[1, 1], [2, 1], [3, 1]]);
      assert.deepEqual(fake.embedCalls, [["a", "bb"], ["ccc"]]);
      assert.equal(usage.inputTokens, 6);
    });

    test("a retryable API error falls back to the next model", async () => {
      const failing = fakeProvider(version, () => ({ content: [], fail: Object.assign(new Error("Too many requests"), { name: "AI_APICallError", statusCode: 429, isRetryable: true }) }));
      const working = fakeProvider(version, () => ({ content: [{ type: "text", text: "From backup" }] }));
      const ai = createAI({ providers: { a: aiSdk(failing.provider), b: aiSdk(working.provider) }, models: { smart: ["a:big", "b:big"] } });
      const result = await ai.generate({ model: "smart", prompt: "Hi" });
      assert.equal(result.text, "From backup");
      assert.equal(result.usage.model, "b:big");

      const only = createAI({ providers: { a: aiSdk(failing.provider) } });
      await assert.rejects(only.generate({ model: "a:big", prompt: "Hi" }), (e: InferloError) => e.code === "IL5003" && String(e.details).includes("returned 429"));
      const denied = fakeProvider(version, () => ({ content: [], fail: Object.assign(new Error("Bad key"), { statusCode: 401 }) }));
      const deniedAI = createAI({ providers: { a: aiSdk(denied.provider), b: aiSdk(working.provider) }, models: { smart: ["a:big", "b:big"] } });
      await assert.rejects(deniedAI.generate({ model: "smart", prompt: "Hi" }), (e: ProviderError) => e.code === "IL5006" && !e.retryable);
    });
  });
}

describe("aiSdk() checks", () => {
  test("anything but an AI SDK provider raises IL5029", async () => {
    for (const bad of [null, {}, "openai", { languageModel: 1 }]) {
      assert.throws(() => aiSdk(bad as never), (e: InferloError) => e.code === "IL5029");
    }
    assert.throws(() => aiSdk(fakeProvider("v4").provider, { name: "has space" }), (e: InferloError) => e.code === "IL5029");
    const old = { languageModel: (id: string) => ({ specificationVersion: "v1", provider: "x", modelId: id }) } as never;
    await assert.rejects(createAI({ providers: { x: aiSdk(old) } }).generate({ model: "x:m", prompt: "Hi" }), (e: InferloError) => e.code === "IL5029" && e.message.includes("v1"));
    const noEmbed = { languageModel: fakeProvider("v4").provider.languageModel };
    await assert.rejects(createAI({ providers: { x: aiSdk(noEmbed) } }).embed({ model: "x:m", input: ["a"] }), (e: InferloError) => e.code === "IL5029");
  });
});

describe("aiSdk() with @ai-sdk/openai-compatible", () => {
  const requests: Call[] = [];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    requests.push(body);
    if (String(_url).endsWith("/embeddings")) {
      return Response.json({ data: body.input.map((_: string, i: number) => ({ embedding: [i, 0.5] })), usage: { prompt_tokens: 4, total_tokens: 4 } });
    }
    if (body.stream) {
      const chunks = [
        { id: "x", created: 0, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Hi " } }] },
        { id: "x", created: 0, model: body.model, choices: [{ index: 0, delta: { content: "there" }, finish_reason: "stop" }] },
        { id: "x", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      ];
      const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    }
    const hasTool = body.messages.some((m: Call) => m.role === "tool");
    const message = body.tools && !hasTool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"id":"T-1"}' } }] }
      : { role: "assistant", content: hasTool ? "Ticket T-1 is open." : "Hello from the AI SDK" };
    return Response.json({ id: "x", created: 0, model: body.model, choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
  };
  const sdk = createOpenAICompatible({ name: "local", baseURL: "http://llm.test/v1", apiKey: "sk-test", fetch: fakeFetch as typeof fetch });
  const ai = createAI({ providers: { local: aiSdk(sdk) }, models: { fast: "local:qwen3" } });

  test("generate, tools, stream and embed through a real AI SDK provider", async () => {
    const plain = await ai.generate({ model: "fast", prompt: "Hello?" });
    assert.equal(plain.text, "Hello from the AI SDK");
    assert.deepEqual([plain.usage.inputTokens, plain.usage.outputTokens], [9, 4]);
    assert.equal(requests[0]!.model, "qwen3");

    const lookup = tool("lookup", { description: "Find a ticket", input: t.object({ id: t.string() }) }).handle(({ input }) => ({ id: input.id, status: "open" }));
    const withTool = await ai.generate({ model: "fast", prompt: "Status of T-1?", tools: [lookup] });
    assert.equal(withTool.text, "Ticket T-1 is open.");
    assert.deepEqual(withTool.steps[0]?.toolCalls[0]?.input, { id: "T-1" });
    assert.equal(requests.at(-1)!.messages.at(-1).role, "tool");

    let streamed = "";
    const stream = ai.stream({ model: "fast", prompt: "Hi" });
    for await (const chunk of stream) streamed += chunk;
    assert.equal(streamed, "Hi there");
    assert.equal((await stream.usage()).outputTokens, 2);

    const { embeddings } = await ai.embed({ model: "local:embed-small", input: ["a", "b"] });
    assert.deepEqual(embeddings, [[0, 0.5], [1, 0.5]]);
  });

  test("an HTTP error is a retryable provider error, without the API key in the message", async () => {
    const failing = createOpenAICompatible({ name: "down", baseURL: "http://llm.test/v1", apiKey: "sk-secret", fetch: (async () => new Response('{"error":{"message":"overloaded"}}', { status: 503 })) as typeof fetch });
    const ai2 = createAI({ providers: { down: aiSdk(failing) } });
    await assert.rejects(ai2.generate({ model: "down:m", prompt: "Hi", maxTokens: 5 }), (e: InferloError) => e.code === "IL5003" && String(e.details).includes("503") && !JSON.stringify(e.details).includes("sk-secret"));
  });
});
