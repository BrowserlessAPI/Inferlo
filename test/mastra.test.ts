// Mastra with Inferlo's AI (@browserlessapi/inferlo/mastra), against real Mastra agents.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { createAI, createApp, InferloError, mockProvider, ProviderError, route, t, tool, type ProviderRequest } from "../src/index.ts";
import { InferloMastraModel, mastraPromptToMessages, toMastraModel, toMastraTools } from "../src/mastra.ts";
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

const agent = (options: Record<string, unknown>) => new Agent({ id: String(options.name).toLowerCase(), instructions: "", ...options } as never);

describe("toMastraModel()", () => {
  test("an agent's model calls go through the alias, with its instructions and usage", async () => {
    const usages: { model: string; for?: string }[] = [];
    const { ai, provider } = weatherAI(usages);
    const model = toMastraModel(ai, { model: "fast", for: "user-1" });
    assert.ok(model instanceof InferloMastraModel);
    // Typed as Mastra's own Agent options: the model fits them on every supported Mastra.
    const echo = new Agent({ id: "echo", name: "Echo", instructions: "Be brief.", model });
    const result = await echo.generate("Hi", { modelSettings: { temperature: 0.1, maxOutputTokens: 30 } } as never);
    assert.equal(result.text, "You said: Hi");
    const sent = provider.calls[0] as ProviderRequest;
    assert.deepEqual(sent.messages.filter((m) => m.role !== "system").map((m) => [m.role, m.content]), [["user", "Hi"]]);
    assert.match(sent.messages[0]!.content, /Be brief\./);
    assert.equal(sent.temperature, 0.1);
    assert.equal(sent.maxTokens, 30);
    assert.equal(usages[0]?.model, "mock:m");
    assert.equal(usages[0]?.for, "user-1");
    assert.ok((result.usage as { inputTokens?: number }).inputTokens! > 0, "usage reaches the result");
  });

  test("the agent loop runs Inferlo function tools and Mastra tools", async () => {
    const { ai, provider } = weatherAI();
    const weather = new Agent({ id: "weather", name: "Weather", instructions: "Use tools.", model: toMastraModel(ai, { model: "fast" }), tools: toMastraTools([getWeather]) });
    const result = await weather.generate("Weather in Oslo?");
    assert.equal(result.text, 'Done: {"city":"Oslo","sky":"sunny"}');
    const spec = (provider.calls[0] as ProviderRequest).tools![0]!;
    assert.equal(spec.name, "getWeather");
    assert.equal(spec.description, "Weather in a city");
    assert.deepEqual((spec.inputSchema as { required?: string[] }).required, ["city"]);
    const second = (provider.calls[1] as ProviderRequest).messages.filter((m) => m.role !== "system");
    assert.deepEqual(second[1]!.toolCalls, [{ id: "call_1", name: "getWeather", input: { city: "Oslo" } }]);
    assert.equal(second[2]!.role, "tool");
    assert.equal(second[2]!.toolCallId, "call_1");

    const forecast = createTool({ id: "forecast", description: "Forecast for a city", inputSchema: z.object({ city: z.string() }), execute: async (input: { city: string }) => `Rain in ${input.city}` } as never);
    const sdk = await agent({ name: "Forecast", model: toMastraModel(ai), tools: { forecast } }).generate("Forecast?");
    assert.equal(sdk.text, "Done: Rain in Oslo");
  });

  test("structured output gets a parsed object", async () => {
    const provider = mockProvider({ respond: () => 'Here you go:\n```json\n{"priority":"high","reason":"outage"}\n```' });
    const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
    const triage = agent({ name: "Triage", instructions: "Triage tickets.", model: toMastraModel(ai, { model: "fast" }) });
    const result = await triage.generate("The site is down", { structuredOutput: { schema: z.object({ priority: z.string(), reason: z.string() }) } } as never);
    assert.deepEqual(result.object, { priority: "high", reason: "outage" });
    const system = (provider.calls[0] as ProviderRequest).messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.match(system, /Triage tickets\./);
    assert.match(system, /JSON Schema/);
  });

  test("streamed answers give the text", async () => {
    const { ai } = weatherAI();
    const stream = await agent({ name: "Echo", model: toMastraModel(ai, { model: "fast" }) }).stream("Hello there");
    let text = "";
    for await (const chunk of stream.textStream) text += chunk;
    assert.equal(text, "You said: Hello there");
    assert.equal(await stream.text, "You said: Hello there");
  });

  test("prompt messages: images, assistant turns and tool results become Inferlo messages", () => {
    const messages = mastraPromptToMessages([
      { role: "system", content: "System text" },
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "file", data: new URL("https://example.com/cat.png"), mediaType: "image/png" },
          { type: "file", data: "iVBORw0K", mediaType: "image/png" },
          { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "Let me check." },
          { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "cat" } },
          { type: "tool-call", toolCallId: "c2", toolName: "lookup", input: "not json" },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "lookup", output: { type: "text", value: "A cat" } },
          { type: "tool-result", toolCallId: "c2", toolName: "lookup", output: { type: "error-text", value: "Unknown" } },
        ],
      },
    ]);
    assert.deepEqual(messages, [
      { role: "system", content: "System text" },
      { role: "user", content: "What is this?", images: [{ url: "https://example.com/cat.png" }, { base64: "iVBORw0K", mediaType: "image/png" }, { base64: "AQID", mediaType: "image/jpeg" }] },
      { role: "assistant", content: "Let me check.", toolCalls: [{ id: "c1", name: "lookup", input: { q: "cat" } }, { id: "c2", name: "lookup", input: {} }] },
      { role: "tool", content: "A cat", toolCallId: "c1" },
      { role: "tool", content: "Unknown", toolCallId: "c2", isError: true },
    ]);
    assert.throws(() => mastraPromptToMessages([{ role: "user", content: [{ type: "file", data: "JVBERi0", mediaType: "application/pdf" }] }]), (e: InferloError) => e.code === "IL5034" && /application\/pdf/.test(e.message));
  });

  test("fallback and errors are Inferlo's; unsupported settings are warnings", async () => {
    const down = mockProvider({
      respond: () => {
        throw new ProviderError("down", 503, "overloaded");
      },
    });
    const ai = createAI({ providers: { down, up: mockProvider({ respond: () => "From backup" }) }, models: { smart: ["down:a", "up:a"] } });
    assert.equal((await agent({ name: "A", model: toMastraModel(ai, { model: "smart" }) }).generate("Hi")).text, "From backup");
    await assert.rejects(toMastraModel(ai, { model: "nope" }).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }), (e: InferloError) => e.code === "IL5001");
    assert.throws(() => toMastraModel({} as never), (e: InferloError) => e.code === "IL5034");
    assert.throws(() => toMastraModel(ai, { temperature: 1 } as never), (e: InferloError) => e.code === "IL5034");
    const model = toMastraModel(ai, { model: "smart" });
    const prompt = [{ role: "user", content: [{ type: "text", text: "Hi" }] }];
    await assert.rejects(model.doGenerate({ prompt, tools: [{ type: "provider-defined", id: "openai.web_search", name: "web_search", args: {} }] }), (e: InferloError) => e.code === "IL5034" && /web_search/.test(e.message));
    const warned = await model.doGenerate({ prompt, topP: 0.5, seed: 1 });
    assert.deepEqual(warned.warnings.map((w) => (w.type === "unsupported-setting" ? w.setting : w.message)), ["topP", "seed"]);
    assert.equal(warned.finishReason, "stop");
    assert.equal(model.specificationVersion, "v2");
  });
});

describe("toMastraTools()", () => {
  test("function tools validate their input; duplicates and other values are refused", async () => {
    const { getWeather: weather } = toMastraTools([getWeather]);
    assert.equal(weather!.id, "getWeather");
    assert.equal(weather!.description, "Weather in a city");
    assert.deepEqual(JSON.parse(String(await weather!.execute!({ city: "Oslo" } as never, {} as never))), { city: "Oslo", sky: "sunny" });
    const refused = String(await weather!.execute!({ town: "Oslo" } as never, {} as never));
    assert.match(refused, /city/i);
    assert.doesNotMatch(refused, /sunny/);
    assert.throws(() => toMastraTools([getWeather, getWeather]), (e: InferloError) => e.code === "IL5013");
    assert.throws(() => toMastraTools([{} as never]), (e: InferloError) => e.code === "IL5034");
    assert.throws(() => toMastraTools("x" as never), (e: InferloError) => e.code === "IL5034");
  });

  test("routes need a request's AI client and run as the signed-in user", async () => {
    const whoami = route.get("/whoami", { tool: { description: "Who is signed in" } }).handle(({ user }) => ({ id: user.id }));
    assert.throws(() => toMastraTools([whoami]), (e: InferloError) => e.code === "IL5009");
    const ask = route.post("/ask").handle(async ({ ai }) => {
      const helper = agent({ name: "Helper", model: toMastraModel(ai, { model: "fast" }), tools: toMastraTools([whoami], { ai }) });
      return { answer: (await helper.generate("Who am I?")).text };
    });
    const provider = mockProvider({
      respond: (r) => (r.messages.at(-1)!.role === "tool" ? `You are ${JSON.parse(r.messages.at(-1)!.content).id}` : { toolCalls: [{ id: "w1", name: r.tools![0]!.name, input: {} }] }),
    });
    const app = createApp({ routes: [{ whoami, ask }], auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" } } });
    const user = { id: "11111111-1111-4111-8111-111111111111" };
    assert.deepEqual(await readJson(await app.request("/ask", { method: "POST", as: user }), 200), { answer: `You are ${user.id}` });
  });

  test("@browserlessapi/inferlo/mastra is a separate entry point, and @mastra/core an optional peer dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(pkg.exports["./mastra"], { types: "./dist/mastra.d.ts", default: "./dist/mastra.js" });
    assert.equal(pkg.peerDependenciesMeta["@mastra/core"].optional, true);
    assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
    assert.doesNotMatch(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /mastra/, "the core never loads Mastra");
  });
});
