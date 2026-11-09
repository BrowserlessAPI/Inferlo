import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readUIMessageStream, type UIMessage } from "ai";
import { anthropic, bearer, createAI, createApp, InferloError, mockProvider, openai, ProviderError, route, t, tool, type Provider, type StreamEvent, type Usage } from "../src/index.ts";

// ai.stream({ tools }): the model calls tools while it streams; text, tool calls and tool results arrive as events,
// and toResponse() sends them to the browser as server-sent events (Inferlo's format or the AI SDK's).

const getWeather = tool("getWeather", { description: "Current weather for a city", input: t.object({ city: t.string().min(1) }) }).handle(({ input }) => ({
  city: input.city,
  sky: "rain",
  secret: "internal-station-7",
}));

/** Calls getWeather first, then answers with the tool's result. */
const weatherModel = () =>
  mockProvider({
    respond: (r) => {
      const last = r.messages.at(-1)!;
      if (last.role === "tool") return `Bring an umbrella: ${JSON.parse(last.content).sky} in Oslo.`;
      return { text: "Let me check. ", toolCalls: [{ id: "c1", name: "getWeather", input: { city: "Oslo" } }] };
    },
  });

const sse = (text: string) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)![1]!;
      const data = /^data: (.*)$/m.exec(block)![1]!;
      return { event, data: JSON.parse(data) as unknown };
    });

const uiChunks = (text: string) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => block.replace(/^data: /, ""))
    .map((data) => (data === "[DONE]" ? data : (JSON.parse(data) as Record<string, unknown>)));

describe("ai.stream with tools", () => {
  test("events() yields text, the tool call and its result, then the final answer; usage covers every step", async () => {
    const usages: Usage[] = [];
    const provider = weatherModel();
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, onUsage: (u) => void usages.push(u) });
    const stream = ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather], for: "ada" });
    const events: StreamEvent[] = [];
    for await (const event of stream.events()) events.push(event);
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    assert.equal(text, "Let me check. Bring an umbrella: rain in Oslo.");
    const tools = events.filter((e) => e.type !== "text");
    assert.deepEqual(tools, [
      { type: "tool-call", id: "c1", name: "getWeather", input: { city: "Oslo" } },
      { type: "tool-result", id: "c1", name: "getWeather", input: { city: "Oslo" }, status: 200, output: { city: "Oslo", sky: "rain", secret: "internal-station-7" }, isError: false },
    ]);
    // The tool call comes after the first step's text and before the answer.
    assert.equal(events.findIndex((e) => e.type === "tool-call") > 0, true);
    assert.equal(await stream.text(), text);
    const steps = await stream.steps();
    assert.equal(steps.length, 2);
    assert.equal(steps[0]!.toolCalls[0]!.name, "getWeather");
    assert.deepEqual(steps[1]!.toolCalls, []);
    const usage = await stream.usage();
    assert.equal(usage.kind, "stream");
    assert.equal(usage.for, "ada");
    assert.equal(usage.inputTokens, steps[0]!.usage.inputTokens + steps[1]!.usage.inputTokens);
    assert.equal(usages.length, 1);
    // The model saw the tool and, on the second call, the tool result.
    assert.deepEqual(provider.calls[0]!.tools!.map((s) => s.name), ["getWeather"]);
    assert.equal(provider.calls[1]!.messages.at(-1)!.role, "tool");
    assert.equal(provider.calls[1]!.messages.at(-2)!.toolCalls![0]!.id, "c1");
  });

  test("iterating the stream yields only text, and text() and steps() read it to the end", async () => {
    const ai = createAI({ providers: { m: weatherModel() }, models: { fast: "m:x" } });
    let text = "";
    for await (const chunk of ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather] })) text += chunk;
    assert.equal(text, "Let me check. Bring an umbrella: rain in Oslo.");
    const stream = ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather] });
    assert.equal((await stream.steps()).length, 2);
    assert.equal(await stream.text(), text);
  });

  test("toResponse() sends tool-call and tool-result events without the tools' output by default", async () => {
    const ai = createAI({ providers: { m: weatherModel() }, models: { fast: "m:x" } });
    const res = ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather] }).toResponse();
    const body = await res.text();
    assert.equal(body.includes("internal-station-7"), false);
    const events = sse(body);
    assert.deepEqual(
      events.map((e) => e.event),
      ["text", "text", "tool-call", "tool-result", ...events.slice(4, -1).map(() => "text"), "done"],
    );
    assert.deepEqual(events[2]!.data, { id: "c1", name: "getWeather", input: { city: "Oslo" } });
    assert.deepEqual(events[3]!.data, { id: "c1", name: "getWeather", status: 200, isError: false });

    const full = await ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather] }).toResponse({ toolOutputs: true }).text();
    const result = sse(full).find((e) => e.event === "tool-result")!;
    assert.deepEqual(result.data, { id: "c1", name: "getWeather", status: 200, isError: false, output: { city: "Oslo", sky: "rain", secret: "internal-station-7" } });
  });

  test("toResponse({ format: \"ai-sdk\" }) sends tool parts that the AI SDK reads into a UI message", async () => {
    const ai = createAI({ providers: { m: weatherModel() }, models: { fast: "m:x" } });
    const body = await ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather] }).toResponse({ format: "ai-sdk", toolOutputs: true }).text();
    const chunks = uiChunks(body);
    const types = chunks.map((c) => (c === "[DONE]" ? c : c.type));
    const first = types.indexOf("tool-input-available");
    assert.deepEqual(types.slice(first - 1, first + 3), ["text-end", "tool-input-available", "tool-output-available", "text-start"]);
    assert.deepEqual(chunks[first], { type: "tool-input-available", toolCallId: "c1", toolName: "getWeather", input: { city: "Oslo" } });
    const ids = chunks.filter((c): c is Record<string, unknown> => typeof c === "object" && c.type === "text-start").map((c) => c.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);

    // The AI SDK's own reader turns the stream into a message with a text part, a tool part and a text part.
    const parsed = chunks.filter((c) => c !== "[DONE]");
    const stream = new ReadableStream({
      start(controller) {
        for (const c of parsed) controller.enqueue(c);
        controller.close();
      },
    });
    let message: UIMessage | undefined;
    for await (const m of readUIMessageStream({ stream: stream as never })) message = m;
    const parts = message!.parts.filter((p) => p.type !== "step-start");
    assert.equal(parts.length, 3);
    assert.equal(parts[0]!.type, "text");
    assert.equal((parts[0] as { text: string }).text, "Let me check. ");
    const toolPart = parts[1] as unknown as { type: string; toolCallId: string; state: string; input: unknown; output: unknown };
    assert.equal(toolPart.type, "tool-getWeather");
    assert.equal(toolPart.toolCallId, "c1");
    assert.equal(toolPart.state, "output-available");
    assert.deepEqual(toolPart.input, { city: "Oslo" });
    assert.deepEqual((toolPart.output as { sky: string }).sky, "rain");
    assert.equal((parts[2] as { text: string }).text, "Bring an umbrella: rain in Oslo.");

    // Without toolOutputs, the output is null, and failed tools are tool-output-error with only the status.
    const failing = tool("lookup", { description: "Fails", input: t.object({}) }).handle(() => {
      throw new InferloError("IL9999", "no row for account hunter2", { status: 404 });
    });
    const ai2 = createAI({
      providers: { m: mockProvider({ respond: (r) => (r.messages.at(-1)!.role === "tool" ? "Sorry." : { toolCalls: [{ id: "f1", name: "lookup" }, { id: "w1", name: "getWeather", input: { city: "Oslo" } }] }) }) },
      models: { fast: "m:x" },
    });
    const errorBody = await ai2.stream({ model: "fast", prompt: "?", tools: [failing, getWeather] }).toResponse({ format: "ai-sdk" }).text();
    assert.equal(errorBody.includes("hunter2"), false);
    const errorChunks = uiChunks(errorBody);
    assert.deepEqual(
      errorChunks.find((c) => typeof c === "object" && c.type === "tool-output-error"),
      { type: "tool-output-error", toolCallId: "f1", errorText: "The tool answered with status 404." },
    );
    assert.deepEqual(
      errorChunks.find((c) => typeof c === "object" && c.type === "tool-output-available"),
      { type: "tool-output-available", toolCallId: "w1", output: null },
    );
  });

  test("routes as tools run as the signed-in user inside a route handler; outside one they raise IL5009", async () => {
    const notes: { title: string; ownerId: string }[] = [];
    const createNote = route.post("/notes", { body: t.object({ title: t.string().min(1) }), summary: "Create a note" }).handle(({ body, user, status }) => {
      status(201);
      const note = { title: body.title, ownerId: user.id };
      notes.push(note);
      return note;
    });
    const wipe = route.delete("/notes", { auth: "admin", summary: "Delete every note" }).handle(() => void notes.splice(0));
    const chat = route.post("/chat", { body: t.object({ prompt: t.string() }) }).handle(({ ai, body, user }) =>
      ai.stream({ model: "fast", prompt: body.prompt, tools: [createNote, wipe], for: user.id }).toResponse(),
    );
    const provider = mockProvider({
      respond: (r) => (r.messages.at(-1)!.role === "tool" ? "Done." : { toolCalls: [{ id: "n1", name: "createNote", input: { title: "Milk" } }, { id: "w1", name: "wipe" }] }),
    });
    const app = createApp({
      routes: [{ createNote, wipe, chat }],
      auth: bearer((token) => (token === "bob" ? { id: "bob", roles: [] } : null)),
      ai: { providers: { mock: provider }, models: { fast: "mock:m" } },
      logger: { info() {}, error() {} },
    });
    const res = await app.request("/chat", { method: "POST", json: { prompt: "Note milk, then wipe everything" }, as: { id: "bob", roles: [] } });
    assert.equal(res.status, 200);
    const events = sse(await res.text());
    const results = events.filter((e) => e.event === "tool-result").map((e) => e.data);
    assert.deepEqual(results, [
      { id: "n1", name: "createNote", status: 201, isError: false },
      { id: "w1", name: "wipe", status: 403, isError: true },
    ]);
    assert.deepEqual(notes, [{ title: "Milk", ownerId: "bob" }]);

    const ai = createAI({ providers: { m: weatherModel() }, models: { fast: "m:x" } });
    await assert.rejects(ai.stream({ model: "fast", prompt: "?", tools: [createNote] }).text(), (e: InferloError) => e.code === "IL5009" && /ai\.stream/.test(e.message));
    await assert.rejects(ai.stream({ model: "fast", prompt: "?", tools: [getWeather, getWeather] }).text(), (e: InferloError) => e.code === "IL5013");
  });

  test("maxSteps limits tool rounds (IL5010), and the toResponse error event carries only the code", async () => {
    const looping = mockProvider({ respond: () => ({ toolCalls: [{ name: "getWeather", input: { city: "Oslo" } }] }) });
    const usages: Usage[] = [];
    const ai = createAI({ providers: { m: looping }, models: { fast: "m:x" }, onUsage: (u) => void usages.push(u) });
    await assert.rejects(ai.stream({ model: "fast", prompt: "?", tools: [getWeather], maxSteps: 2 }).text(), (e: InferloError) => e.code === "IL5010");
    assert.equal(looping.calls.length, 2);
    assert.equal(usages.length, 1, "usage of the steps that ran is recorded");
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const events = sse(await ai.stream({ model: "fast", prompt: "?", tools: [getWeather], maxSteps: 2 }).toResponse().text());
      assert.deepEqual(events.at(-1), { event: "error", data: { code: "IL5010" } });
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
  });

  test("falls back to the next model before anything was sent, never after a tool ran", async () => {
    const down: Provider = {
      name: "down",
      async generate() {
        throw new ProviderError("down", 503, "overloaded");
      },
      async *stream() {
        throw new ProviderError("down", 503, "overloaded");
      },
    };
    const ai = createAI({ providers: { down, m: weatherModel() }, models: { fast: ["down:x", "m:x"] } });
    assert.equal(await ai.stream({ model: "fast", prompt: "?", tools: [getWeather] }).text(), "Let me check. Bring an umbrella: rain in Oslo.");

    // A model that fails after the tool ran: no fallback (the tool would run twice), IL5006.
    let runs = 0;
    const counted = tool("count", { description: "Counts", input: t.object({}) }).handle(() => ++runs);
    let call = 0;
    const flaky: Provider = {
      name: "flaky",
      async generate() {
        throw new Error("unused");
      },
      async *stream() {
        if (call++ === 0) {
          yield { usage: { inputTokens: 1, outputTokens: 1 } };
          yield { toolCalls: [{ id: "k1", name: "count", input: {} }] };
          return;
        }
        throw new ProviderError("flaky", 503, "overloaded");
      },
    };
    const ai2 = createAI({ providers: { flaky, m: weatherModel() }, models: { fast: ["flaky:x", "m:x"] } });
    await assert.rejects(ai2.stream({ model: "fast", prompt: "?", tools: [counted] }).text(), (e: InferloError) => e.code === "IL5006" && /does not retry/.test(e.fix ?? ""));
    assert.equal(runs, 1);
  });

  test("budgets are checked before every model call that follows tool calls", async () => {
    let allowed = 1;
    const ai = createAI({ providers: { m: weatherModel() }, models: { fast: "m:x" }, allow: () => allowed-- > 0 });
    await assert.rejects(ai.stream({ model: "fast", prompt: "?", tools: [getWeather], for: "ada" }).text(), (e: InferloError) => e.code === "IL5004");
  });

  test("OpenAI streams tool calls in pieces; Inferlo joins them", async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const chunks = (list: unknown[]) => list.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const provider = openai({
      apiKey: "sk-test",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init!.body)));
        const body =
          n++ === 0
            ? chunks([
                { choices: [{ delta: { content: "Checking. " } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "getWeather", arguments: "" } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
                { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] } }] },
                { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
              ])
            : chunks([{ choices: [{ delta: { content: "Rain." } }] }, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } }]);
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const ai = createAI({ providers: { openai: provider }, models: { fast: "openai:gpt-5-mini" } });
    const stream = ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather] });
    const events: StreamEvent[] = [];
    for await (const e of stream.events()) events.push(e);
    assert.deepEqual(events.map((e) => e.type), ["text", "tool-call", "tool-result", "text"]);
    assert.deepEqual(events[1], { type: "tool-call", id: "call_a", name: "getWeather", input: { city: "Oslo" } });
    assert.equal((await stream.usage()).inputTokens, 30);
    assert.equal((bodies[0]!.tools as { function: { name: string } }[])[0]!.function.name, "getWeather");
    const second = bodies[1]!.messages as Record<string, unknown>[];
    assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "call_a", content: '{"city":"Oslo","sky":"rain","secret":"internal-station-7"}' });
  });

  test("Anthropic streams tool_use blocks with their input as JSON pieces; Inferlo joins them", async () => {
    let n = 0;
    const events = (list: unknown[]) => list.map((c) => `event: x\ndata: ${JSON.stringify(c)}\n\n`).join("");
    const provider = anthropic({
      apiKey: "sk-ant",
      fetch: async () => {
        const body =
          n++ === 0
            ? events([
                { type: "message_start", message: { usage: { input_tokens: 12 } } },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "One moment. " } },
                { type: "content_block_stop", index: 0 },
                { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "getWeather", input: {} } },
                { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ci' } },
                { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ty":"Oslo"}' } },
                { type: "content_block_stop", index: 1 },
                { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
                { type: "message_stop" },
              ])
            : events([
                { type: "message_start", message: { usage: { input_tokens: 30 } } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Rain." } },
                { type: "message_delta", usage: { output_tokens: 2 } },
              ]);
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const ai = createAI({ providers: { anthropic: provider }, models: { fast: "anthropic:claude-haiku-4-5" } });
    const stream = ai.stream({ model: "fast", prompt: "Umbrella?", tools: [getWeather] });
    const list: StreamEvent[] = [];
    for await (const e of stream.events()) list.push(e);
    assert.deepEqual(list[1], { type: "tool-call", id: "toolu_1", name: "getWeather", input: { city: "Oslo" } });
    assert.equal(await stream.text(), "One moment. Rain.");
    const usage = await stream.usage();
    assert.deepEqual([usage.inputTokens, usage.outputTokens], [42, 11]);
  });

  test("a stream without tools is unchanged", async () => {
    const ai = createAI({ providers: { m: mockProvider({ respond: () => "Plain answer." }) }, models: { fast: "m:x" } });
    const stream = ai.stream({ model: "fast", prompt: "Hi" });
    const events = sse(await stream.toResponse().text());
    assert.deepEqual(events.map((e) => e.event), ["text", "text", "done"]);
    assert.equal(await stream.text(), "Plain answer.");
    assert.deepEqual(await stream.steps(), [{ text: "Plain answer.", toolCalls: [], usage: (await stream.steps())[0]!.usage }]);
  });
});
