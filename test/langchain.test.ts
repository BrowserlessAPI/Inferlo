import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { tool as langchainTool } from "@langchain/core/tools";
import { createAI, createApp, InferloError, mockProvider, ProviderError, route, t, tool, type ProviderRequest } from "../src/index.ts";
import { InferloChatModel, toLangChainModel, toLangChainTools } from "../src/langchain.ts";
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
  return { provider, ai: createAI({ providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usages.push(u) }) };
}

describe("toLangChainModel()", () => {
  test("invoke sends LangChain messages through the alias and returns an AIMessage with usage", async () => {
    const usages: { model: string; for?: string }[] = [];
    const { ai, provider } = weatherAI(usages);
    const model = toLangChainModel(ai, { model: "fast", for: "user-1", temperature: 0.1, maxTokens: 30 });
    assert.ok(model instanceof InferloChatModel);
    assert.equal(model._llmType(), "inferlo");
    const answer = await model.invoke([new SystemMessage("Be brief."), new HumanMessage("Hi")]);
    assert.equal(answer.content, "You said: Hi");
    assert.ok(answer.usage_metadata && answer.usage_metadata.input_tokens > 0);
    const sent = provider.calls[0] as ProviderRequest;
    assert.deepEqual(sent.messages.map((m) => [m.role, m.content]), [["system", "Be brief."], ["user", "Hi"]]);
    assert.equal(sent.temperature, 0.1);
    assert.equal(sent.maxTokens, 30);
    assert.equal(usages[0]?.model, "mock:m");
    assert.equal(usages[0]?.for, "user-1");
    assert.equal((await model.invoke("Plain string")).content, "You said: Plain string", "strings work too");
  });

  test("bindTools returns tool calls without running them, and tool results go back to the model", async () => {
    const { ai, provider } = weatherAI();
    const lcTool = langchainTool(async ({ city }: { city: string }) => `Rain in ${city}`, {
      name: "forecast",
      description: "Forecast for a city",
      schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } as never,
    });
    const model = toLangChainModel(ai, { model: "fast" }).bindTools([lcTool]);
    const first = await model.invoke([new HumanMessage("Weather in Oslo?")]);
    assert.deepEqual(first.tool_calls?.map((c: { name: string; args: unknown; id?: string }) => [c.name, c.args, c.id]), [["forecast", { city: "Oslo" }, "call_1"]]);
    const spec = (provider.calls[0] as ProviderRequest).tools![0]!;
    assert.equal(spec.name, "forecast");
    assert.equal(spec.description, "Forecast for a city");
    assert.deepEqual((spec.inputSchema as { required?: string[] }).required, ["city"]);

    const toolResult = await lcTool.invoke(first.tool_calls![0]!);
    const second = await model.invoke([new HumanMessage("Weather in Oslo?"), first, toolResult]);
    assert.equal(second.content, "Done: Rain in Oslo");
    const sent = (provider.calls[1] as ProviderRequest).messages;
    assert.deepEqual(sent[1]!.toolCalls, [{ id: "call_1", name: "forecast", input: { city: "Oslo" } }]);
    assert.equal(sent[2]!.role, "tool");
    assert.equal(sent[2]!.toolCallId, "call_1");
    // Inferlo function tools and OpenAI-style definitions can be bound too.
    const both = toLangChainModel(ai).bindTools([getWeather, { type: "function", function: { name: "lookup", description: "Find", parameters: { type: "object", properties: {} } } }]);
    await both.invoke("Hi");
    assert.deepEqual((provider.calls.at(-1) as ProviderRequest).tools!.map((x) => x.name), ["getWeather", "lookup"]);
  });

  test("stream yields text chunks and usage; with tools it yields the tool calls", async () => {
    const { ai } = weatherAI();
    const model = toLangChainModel(ai, { model: "fast" });
    let text = "";
    let usage = 0;
    for await (const chunk of await model.stream("Hello there")) {
      text += chunk.content;
      usage += chunk.usage_metadata?.output_tokens ?? 0;
    }
    assert.equal(text, "You said: Hello there");
    assert.ok(usage > 0);
    const chunks = [];
    for await (const chunk of await model.bindTools([getWeather]).stream("Weather?")) chunks.push(chunk);
    assert.equal(chunks[0]!.tool_call_chunks?.[0]?.name, "getWeather");
  });

  test("images in human messages reach the model", async () => {
    const { ai, provider } = weatherAI();
    await toLangChainModel(ai).invoke([
      new HumanMessage({ content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "https://example.com/cat.png" } }] }),
    ]);
    const sent = (provider.calls[0] as ProviderRequest).messages[0]!;
    assert.equal(sent.content, "What is this?");
    assert.deepEqual(sent.images, [{ url: "https://example.com/cat.png" }]);
  });

  test("fallback and errors are Inferlo's", async () => {
    const down = mockProvider({
      respond: () => {
        throw new ProviderError("down", 503, "overloaded");
      },
    });
    const ai = createAI({ providers: { down, up: mockProvider({ respond: () => "From backup" }) }, models: { smart: ["down:a", "up:a"] } });
    const answer = await toLangChainModel(ai, { model: "smart" }).invoke("Hi");
    assert.equal(answer.content, "From backup");
    assert.equal(answer.response_metadata.model, "up:a");
    await assert.rejects(toLangChainModel(ai, { model: "nope" }).invoke("Hi"), (e: InferloError) => e.code === "IL5001");
    assert.throws(() => toLangChainModel({} as never), (e: InferloError) => e.code === "IL5030");
    assert.throws(() => toLangChainModel(ai, { modle: "fast" } as never), (e: InferloError) => e.code === "IL5030");
    await assert.rejects(toLangChainModel(ai, { model: "smart" }).invoke([new SystemMessage("Only a system message")]), (e: InferloError) => e.code === "IL5007");
  });
});

describe("toLangChainTools()", () => {
  test("function tools become LangChain tools that validate their input", async () => {
    const [weather] = toLangChainTools([getWeather]);
    assert.equal(weather!.name, "getWeather");
    assert.equal(weather!.description, "Weather in a city");
    assert.deepEqual(JSON.parse(String(await weather!.invoke({ city: "Oslo" }))), { city: "Oslo", sky: "sunny" });
    // Invalid input is refused: by LangChain's own JSON Schema check (1.x), or by the tool's schema (an error text the model sees).
    const refused = await weather!.invoke({ town: "Oslo" } as never).then(String, (e: Error) => e.message);
    assert.match(refused, /schema|city|town|Invalid/i);
    assert.doesNotMatch(refused, /sunny/);
    assert.throws(() => toLangChainTools([getWeather, getWeather]), (e: InferloError) => e.code === "IL5013");
    assert.throws(() => toLangChainTools([{} as never]), (e: InferloError) => e.code === "IL5030");
  });

  test("routes need a request's AI client and run as the signed-in user", async () => {
    const whoami = route.get("/whoami", { tool: { description: "Who is signed in" } }).handle(({ user }) => ({ id: user.id }));
    assert.throws(() => toLangChainTools([whoami]), (e: InferloError) => e.code === "IL5009");
    const agentRoute = route.post("/agent").handle(async ({ ai }) => {
      const [tool] = toLangChainTools([whoami, getWeather], { ai });
      return { answer: JSON.parse(String(await tool!.invoke({}))) };
    });
    const app = createApp({
      routes: [{ whoami, agentRoute }],
      auth: { resolve: () => null },
      ai: { providers: { mock: mockProvider({ respond: () => "ok" }) }, models: { fast: "mock:m" } },
    });
    const user = { id: "11111111-1111-4111-8111-111111111111" };
    assert.deepEqual(await readJson(await app.request("/agent", { method: "POST", as: user }), 200), { answer: { id: user.id } });
    // The chat model works with ctx.ai too.
    const chat = route.post("/chat").handle(async ({ ai }) => ({ text: (await toLangChainModel(ai, { model: "fast" }).invoke("Hi")).content }));
    const app2 = createApp({ routes: [{ chat }], auth: { resolve: () => null }, ai: { providers: { mock: mockProvider({ respond: () => "Hello" }) }, models: { fast: "mock:m" } } });
    assert.deepEqual(await readJson(await app2.request("/chat", { method: "POST", as: user }), 200), { text: "Hello" });
  });

  test("@browserlessapi/inferlo/langchain is a separate entry point, and @langchain/core an optional peer dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.deepEqual(pkg.exports["./langchain"], { types: "./dist/langchain.d.ts", default: "./dist/langchain.js" });
    assert.equal(pkg.peerDependenciesMeta["@langchain/core"].optional, true);
    assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
    assert.doesNotMatch(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /langchain/, "the core never loads LangChain");
  });
});
