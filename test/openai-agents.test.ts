// The OpenAI Agents SDK with Inferlo's AI (@browserlessapi/inferlo/openai-agents), against the real Agents SDK runner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { Agent, handoff, run, setTracingDisabled, tool as agentsTool } from "@openai/agents-core";
import { createAI, createApp, InferloError, mockProvider, ProviderError, route, t, tool, type ProviderRequest } from "../src/index.ts";
import { InferloAgentsModel, agentInputToMessages, toOpenAIAgentsModel, toOpenAIAgentsTools } from "../src/openai-agents.ts";
import { readJson } from "../src/testing.ts";

setTracingDisabled(true);

const getWeather = tool("getWeather", { description: "Weather in a city", input: t.object({ city: t.string() }) }).handle(({ input }) => ({ city: input.city, sky: "sunny" }));

function weatherAI(usages: { model: string; for?: string }[] = []) {
  const provider = mockProvider({
    respond: (r) =>
      r.messages.at(-1)!.role === "tool"
        ? `Done: ${r.messages.at(-1)!.content}`
        : r.tools?.length
          ? { toolCalls: [{ id: "call_1", name: r.tools[0]!.name, input: { city: "Oslo" } }] }
          : `You said: ${r.messages.at(-1)!.content}`,
  });
  return { provider, ai: createAI({ providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usages.push(u) }) };
}

describe("toOpenAIAgentsModel()", () => {
  test("an agent's model calls go through the alias, with its instructions and usage", async () => {
    const usages: { model: string; for?: string }[] = [];
    const { ai, provider } = weatherAI(usages);
    const model = toOpenAIAgentsModel(ai, { model: "fast", for: "user-1" });
    assert.ok(model instanceof InferloAgentsModel);
    const agent = new Agent({ name: "Echo", instructions: "Be brief.", model, modelSettings: { temperature: 0.1, maxTokens: 30 } });
    const result = await run(agent, "Hi");
    assert.equal(result.finalOutput, "You said: Hi");
    const sent = provider.calls[0] as ProviderRequest;
    assert.deepEqual(sent.messages.map((m) => [m.role, m.content]), [["system", "Be brief."], ["user", "Hi"]]);
    assert.equal(sent.temperature, 0.1);
    assert.equal(sent.maxTokens, 30);
    assert.equal(usages[0]?.model, "mock:m");
    assert.equal(usages[0]?.for, "user-1");
    assert.ok(result.state.usage.inputTokens > 0, "usage reaches the run");
  });

  test("the agent loop runs Inferlo function tools and Agents SDK tools", async () => {
    const { ai, provider } = weatherAI();
    const agent = new Agent({ name: "Weather", instructions: "Use tools.", model: toOpenAIAgentsModel(ai, { model: "fast" }), tools: toOpenAIAgentsTools([getWeather]) });
    const result = await run(agent, "Weather in Oslo?");
    assert.equal(result.finalOutput, 'Done: {"city":"Oslo","sky":"sunny"}');
    const spec = (provider.calls[0] as ProviderRequest).tools![0]!;
    assert.equal(spec.name, "getWeather");
    assert.equal(spec.description, "Weather in a city");
    assert.deepEqual((spec.inputSchema as { required?: string[] }).required, ["city"]);
    const second = (provider.calls[1] as ProviderRequest).messages;
    assert.deepEqual(second[2]!.toolCalls, [{ id: "call_1", name: "getWeather", input: { city: "Oslo" } }]);
    assert.equal(second[3]!.role, "tool");
    assert.equal(second[3]!.toolCallId, "call_1");

    const forecast = agentsTool({
      name: "forecast",
      description: "Forecast for a city",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } as never,
      strict: false,
      execute: async (input: unknown) => `Rain in ${(input as { city: string }).city}`,
    });
    const sdk = await run(new Agent({ name: "Forecast", model: toOpenAIAgentsModel(ai), tools: [forecast] }), "Forecast?");
    assert.equal(sdk.finalOutput, "Done: Rain in Oslo");
  });

  test("a JSON schema outputType gets a parsed final output", async () => {
    const provider = mockProvider({ respond: () => 'Here you go:\n```json\n{"priority":"high","reason":"outage"}\n```' });
    const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
    const outputType = {
      type: "json_schema" as const,
      name: "Triage",
      strict: false,
      schema: { type: "object" as const, properties: { priority: { type: "string" }, reason: { type: "string" } }, required: ["priority", "reason"], additionalProperties: false },
    };
    const agent = new Agent({ name: "Triage", instructions: "Triage tickets.", model: toOpenAIAgentsModel(ai, { model: "fast" }), outputType: outputType as never }) as unknown as Agent<any, any>;
    const result = await run(agent, "The site is down");
    assert.deepEqual(result.finalOutput, { priority: "high", reason: "outage" });
    const system = (provider.calls[0] as ProviderRequest).messages[0]!;
    assert.match(system.content, /^Triage tickets\.\n\n.*JSON Schema/s);
  });

  test("streamed runs give the text and the final output", async () => {
    const { ai } = weatherAI();
    const agent = new Agent({ name: "Echo", model: toOpenAIAgentsModel(ai, { model: "fast" }) });
    const stream = await run(agent, "Hello there", { stream: true });
    let text = "";
    for await (const chunk of stream.toTextStream()) text += chunk;
    await stream.completed;
    assert.equal(text, "You said: Hello there");
    assert.equal(stream.finalOutput, "You said: Hello there");
  });

  test("handoffs between agents run on Inferlo models", async () => {
    const provider = mockProvider({
      respond: (r) => {
        const handoffTool = r.tools?.find((x) => x.name.startsWith("transfer_to_"));
        if (handoffTool && r.messages.at(-1)!.role === "user") return { toolCalls: [{ id: "h1", name: handoffTool.name, input: {} }] };
        return `Billing here: ${r.messages.find((m) => m.role === "user")!.content}`;
      },
    });
    const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
    const billing = new Agent({ name: "Billing", instructions: "Handle invoices.", model: toOpenAIAgentsModel(ai, { model: "fast" }) });
    const triage = new Agent({ name: "Triage", model: toOpenAIAgentsModel(ai, { model: "fast" }), handoffs: [handoff(billing)] });
    const result = await run(triage, "Where is my invoice?");
    assert.equal(result.finalOutput, "Billing here: Where is my invoice?");
    assert.equal(result.lastAgent?.name, "Billing");
  });

  test("input items: images, assistant turns and tool results become Inferlo messages", () => {
    const messages = agentInputToMessages([
      { role: "user", content: [{ type: "input_text", text: "What is this?" }, { type: "input_image", image: "https://example.com/cat.png" }, { type: "input_image", image: "data:image/png;base64,iVBORw0K" }] },
      { role: "assistant", status: "completed", content: [{ type: "output_text", text: "Let me check." }] },
      { type: "function_call", callId: "c1", name: "lookup", arguments: '{"q":"cat"}' },
      { type: "function_call", callId: "c2", name: "lookup", arguments: "not json" },
      { type: "function_call_result", callId: "c1", name: "lookup", status: "completed", output: { type: "text", text: "A cat" } },
      { type: "function_call_result", callId: "c2", name: "lookup", status: "completed", output: "Unknown" },
      { type: "reasoning", content: [] },
    ] as never, "System text");
    assert.deepEqual(messages, [
      { role: "system", content: "System text" },
      { role: "user", content: "What is this?", images: [{ url: "https://example.com/cat.png" }, { base64: "iVBORw0K", mediaType: "image/png" }] },
      { role: "assistant", content: "Let me check.", toolCalls: [{ id: "c1", name: "lookup", input: { q: "cat" } }, { id: "c2", name: "lookup", input: {} }] },
      { role: "tool", content: "A cat", toolCallId: "c1" },
      { role: "tool", content: "Unknown", toolCallId: "c2" },
    ]);
  });

  test("fallback and errors are Inferlo's", async () => {
    const down = mockProvider({
      respond: () => {
        throw new ProviderError("down", 503, "overloaded");
      },
    });
    const ai = createAI({ providers: { down, up: mockProvider({ respond: () => "From backup" }) }, models: { smart: ["down:a", "up:a"] } });
    const result = await run(new Agent({ name: "A", model: toOpenAIAgentsModel(ai, { model: "smart" }) }), "Hi");
    assert.equal(result.finalOutput, "From backup");
    await assert.rejects(run(new Agent({ name: "B", model: toOpenAIAgentsModel(ai, { model: "nope" }) }), "Hi"), (e: unknown) => (e as InferloError).code === "IL5001" || /IL5001/.test(String((e as Error).message)));
    assert.throws(() => toOpenAIAgentsModel({} as never), (e: InferloError) => e.code === "IL5033");
    assert.throws(() => toOpenAIAgentsModel(ai, { temperature: 1 } as never), (e: InferloError) => e.code === "IL5033");
    const hosted = { type: "hosted_tool", name: "web_search" };
    await assert.rejects(toOpenAIAgentsModel(ai, { model: "smart" }).getResponse({ input: "Hi", modelSettings: {}, tools: [hosted], handoffs: [], outputType: "text", tracing: false } as never), (e: InferloError) => e.code === "IL5033" && /web_search/.test(e.message));
  });
});

describe("toOpenAIAgentsTools()", () => {
  test("function tools validate their input; duplicates and other values are refused", async () => {
    const [weather] = toOpenAIAgentsTools([getWeather]);
    assert.equal(weather!.name, "getWeather");
    assert.equal(weather!.type, "function");
    assert.deepEqual(JSON.parse(String(await weather!.invoke({} as never, JSON.stringify({ city: "Oslo" })))), { city: "Oslo", sky: "sunny" });
    const refused = String(await weather!.invoke({} as never, JSON.stringify({ town: "Oslo" })));
    assert.match(refused, /city/i);
    assert.doesNotMatch(refused, /sunny/);
    assert.throws(() => toOpenAIAgentsTools([getWeather, getWeather]), (e: InferloError) => e.code === "IL5013");
    assert.throws(() => toOpenAIAgentsTools([{} as never]), (e: InferloError) => e.code === "IL5033");
    assert.throws(() => toOpenAIAgentsTools("x" as never), (e: InferloError) => e.code === "IL5033");
  });

  test("routes need a request's AI client and run as the signed-in user", async () => {
    const whoami = route.get("/whoami", { tool: { description: "Who is signed in" } }).handle(({ user }) => ({ id: user.id }));
    assert.throws(() => toOpenAIAgentsTools([whoami]), (e: InferloError) => e.code === "IL5009");
    const ask = route.post("/ask").handle(async ({ ai }) => {
      const agent = new Agent({ name: "Helper", model: toOpenAIAgentsModel(ai, { model: "fast" }), tools: toOpenAIAgentsTools([whoami], { ai }) });
      return { answer: (await run(agent, "Who am I?")).finalOutput };
    });
    const provider = mockProvider({
      respond: (r) => (r.messages.at(-1)!.role === "tool" ? `You are ${JSON.parse(r.messages.at(-1)!.content).id}` : { toolCalls: [{ id: "w1", name: r.tools![0]!.name, input: {} }] }),
    });
    const app = createApp({ routes: [{ whoami, ask }], auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" } } });
    const user = { id: "11111111-1111-4111-8111-111111111111" };
    assert.deepEqual(await readJson(await app.request("/ask", { method: "POST", as: user }), 200), { answer: `You are ${user.id}` });
  });

  test("@browserlessapi/inferlo/openai-agents is a separate entry point, and @openai/agents-core an optional peer dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(pkg.exports["./openai-agents"], { types: "./dist/openai-agents.d.ts", default: "./dist/openai-agents.js" });
    assert.equal(pkg.peerDependenciesMeta["@openai/agents-core"].optional, true);
    assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
    assert.doesNotMatch(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /openai-agents/, "the core never loads the Agents SDK");
  });
});
