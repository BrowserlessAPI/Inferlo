// Inferlo's AI as a Vercel AI SDK model and Inferlo tools as AI SDK tools (toAISdkModel, toAISdkTools), against the
// real AI SDK (ai 5 and later; the CI AI SDK job runs the oldest supported and the latest).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateObject, generateText, jsonSchema, stepCountIs, streamText, tool as aiTool } from "ai";
import { createAI, createApp, InferloAISdkModel, InferloError, mockProvider, ProviderError, route, t, toAISdkModel, toAISdkTools, tool, type ProviderRequest } from "../src/index.ts";
import * as aiEntry from "../src/ai/public.ts";
import { readJson } from "../src/testing.ts";

const getWeather = tool("getWeather", { description: "Weather in a city", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city, sky: "sunny" }));

function weatherAI(usages: { model: string; for?: string }[] = []) {
  const provider = mockProvider({
    respond: (r) =>
      r.messages.at(-1)!.role === "tool"
        ? `Done: ${r.messages.at(-1)!.content}`
        : r.tools?.length
          ? { toolCalls: [{ id: "call_1", name: r.tools[0]!.name, input: { city: "Oslo" } }] }
          : `You said: ${r.messages.filter((m) => m.role === "user").at(-1)!.content}`,
  });
  return { provider, ai: createAI({ providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usages.push(u) }) };
}

describe("toAISdkModel()", () => {
  test("generateText calls the alias with the system prompt and settings, and reports usage", async () => {
    const usages: { model: string; for?: string }[] = [];
    const { ai, provider } = weatherAI(usages);
    const model = toAISdkModel(ai, { model: "fast", for: "user-1" });
    assert.ok(model instanceof InferloAISdkModel);
    assert.equal(model.specificationVersion, "v2");
    const result = await generateText({ model, system: "Be brief.", prompt: "Hi", temperature: 0.1, maxOutputTokens: 30 });
    assert.equal(result.text, "You said: Hi");
    const sent = provider.calls[0] as ProviderRequest;
    assert.deepEqual(sent.messages.map((m) => [m.role, m.content]), [["system", "Be brief."], ["user", "Hi"]]);
    assert.equal(sent.temperature, 0.1);
    assert.equal(sent.maxTokens, 30);
    assert.equal(usages[0]?.model, "mock:m");
    assert.equal(usages[0]?.for, "user-1");
    assert.ok((result.usage.inputTokens ?? 0) > 0);
    assert.equal(result.finishReason, "stop");
  });

  test("the AI SDK's tool loop runs Inferlo tools and AI SDK tools", async () => {
    const { ai, provider } = weatherAI();
    const result = await generateText({ model: toAISdkModel(ai, { model: "fast" }), tools: toAISdkTools([getWeather]), stopWhen: stepCountIs(3), prompt: "Weather in Oslo?" });
    assert.equal(result.text, 'Done: {"city":"Oslo","sky":"sunny"}');
    const spec = (provider.calls[0] as ProviderRequest).tools![0]!;
    assert.equal(spec.name, "getWeather");
    assert.deepEqual((spec.inputSchema as { required?: string[] }).required, ["city"]);
    const second = (provider.calls[1] as ProviderRequest).messages;
    assert.deepEqual(second[1]!.toolCalls, [{ id: "call_1", name: "getWeather", input: { city: "Oslo" } }]);
    assert.equal(second[2]!.toolCallId, "call_1");

    const forecast = aiTool({
      description: "Forecast for a city",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: async ({ city }: { city: string }) => `Rain in ${city}`,
    } as never);
    const sdk = await generateText({ model: toAISdkModel(ai), tools: { forecast }, stopWhen: stepCountIs(3), prompt: "Forecast?" });
    assert.equal(sdk.text, "Done: Rain in Oslo");
  });

  test("streamText streams the answer, and generateObject gets the parsed object", async () => {
    const { ai } = weatherAI();
    const stream = streamText({ model: toAISdkModel(ai, { model: "fast" }), prompt: "Hello there" });
    let text = "";
    for await (const chunk of stream.textStream) text += chunk;
    assert.equal(text, "You said: Hello there");
    const provider = mockProvider({ respond: () => 'Sure:\n```json\n{"priority":"high"}\n```' });
    const json = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
    const { object } = await generateObject({ model: toAISdkModel(json, { model: "fast" }), schema: jsonSchema<{ priority: string }>({ type: "object", properties: { priority: { type: "string" } }, required: ["priority"] }), prompt: "Triage: site down" });
    assert.deepEqual(object, { priority: "high" });
    assert.match((provider.calls[0] as ProviderRequest).messages[0]!.content, /JSON Schema/);
  });

  test("fallback and errors are Inferlo's", async () => {
    const down = mockProvider({
      respond: () => {
        throw new ProviderError("down", 503, "overloaded");
      },
    });
    const ai = createAI({ providers: { down, up: mockProvider({ respond: () => "From backup" }) }, models: { smart: ["down:a", "up:a"] } });
    assert.equal((await generateText({ model: toAISdkModel(ai, { model: "smart" }), prompt: "Hi" })).text, "From backup");
    assert.throws(() => toAISdkModel({} as never), (e: InferloError) => e.code === "IL5035");
    assert.throws(() => toAISdkModel(ai, { temperature: 1 } as never), (e: InferloError) => e.code === "IL5035");
    await assert.rejects(
      toAISdkModel(ai).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }], tools: [{ type: "provider-defined", id: "openai.web_search", name: "web_search", args: {} }] }),
      (e: InferloError) => e.code === "IL5035" && /web_search/.test(e.message),
    );
    await assert.rejects(toAISdkModel(ai).doGenerate({ prompt: [{ role: "user", content: [{ type: "file", data: "JVBERi0", mediaType: "application/pdf" }] }] }), (e: InferloError) => e.code === "IL5035");
  });
});

describe("toAISdkTools()", () => {
  test("function tools validate their input; routes run as the signed-in user", async () => {
    const { getWeather: weather } = toAISdkTools([getWeather]);
    assert.equal(weather!.description, "Weather in a city");
    assert.match(String(await weather!.execute({ town: "Oslo" })), /city/i);
    assert.throws(() => toAISdkTools([getWeather, getWeather]), (e: InferloError) => e.code === "IL5013");
    assert.throws(() => toAISdkTools([{} as never]), (e: InferloError) => e.code === "IL5035");
    assert.throws(() => toAISdkTools("x" as never), (e: InferloError) => e.code === "IL5035");

    const whoami = route.get("/whoami", { tool: { description: "Who is signed in" } }).handle(({ user }) => ({ id: user.id }));
    assert.throws(() => toAISdkTools([whoami]), (e: InferloError) => e.code === "IL5009");
    const ask = route.post("/ask").handle(async ({ ai }) => {
      const { text } = await generateText({ model: toAISdkModel(ai, { model: "fast" }), tools: toAISdkTools([whoami], { ai }), stopWhen: stepCountIs(3), prompt: "Who am I?" });
      return { answer: text };
    });
    const provider = mockProvider({
      respond: (r) => (r.messages.at(-1)!.role === "tool" ? `You are ${JSON.parse(r.messages.at(-1)!.content).id}` : { toolCalls: [{ id: "w1", name: r.tools![0]!.name, input: {} }] }),
    });
    const app = createApp({ routes: [{ whoami, ask }], auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" } } });
    const user = { id: "11111111-1111-4111-8111-111111111111" };
    assert.deepEqual(await readJson(await app.request("/ask", { method: "POST", as: user }), 200), { answer: `You are ${user.id}` });
  });

  test("both are in the AI module entry point too", () => {
    assert.equal(aiEntry.toAISdkModel, toAISdkModel);
    assert.equal(aiEntry.toAISdkTools, toAISdkTools);
  });
});
