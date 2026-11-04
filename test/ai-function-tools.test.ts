import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAI, InferloError, httpError, mockProvider, t, tool, isTool, createApp, route, bearer, type Usage } from "../src/index.ts";
import * as standalone from "../src/ai/public.ts";
import { readJson } from "../src/testing.ts";

const getWeather = tool("getWeather", {
  description: "Current weather for a city",
  input: t.object({ city: t.string().min(1), unit: t.enum(["c", "f"]).default("c") }),
}).handle(({ input }) => ({ city: input.city, temperature: input.unit === "c" ? 21 : 70, unit: input.unit }));

/** A provider that calls the given tool once, then answers with the last tool result. */
const callsOnce = (name: string, input: unknown) =>
  mockProvider({ respond: (r) => (r.messages.at(-1)!.role === "tool" ? `Result: ${r.messages.at(-1)!.content}` : { toolCalls: [{ name, input }] }) });

describe("tool(): tool calling with plain functions", () => {
  test("defines a tool and is exported from both entry points", () => {
    assert.ok(isTool(getWeather));
    assert.equal(getWeather.name, "getWeather");
    assert.equal(standalone.tool, tool);
    assert.equal(standalone.isTool, isTool);
  });

  test("works with createAI outside createApp: the model calls the function with validated input", async () => {
    const provider = callsOnce("getWeather", { city: "Oslo" });
    const usage: Usage[] = [];
    const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
    const r = await ai.generate({ model: "fast", prompt: "Weather in Oslo?", tools: [getWeather], for: "u1" });
    assert.equal(r.text, 'Result: {"city":"Oslo","temperature":21,"unit":"c"}');
    assert.equal(r.steps.length, 2);
    assert.deepEqual(r.steps[0]!.toolCalls[0], {
      id: r.steps[0]!.toolCalls[0]!.id,
      name: "getWeather",
      input: { city: "Oslo" },
      status: 200,
      output: { city: "Oslo", temperature: 21, unit: "c" },
      isError: false,
    });
    // The model was offered the tool with its description and the input's JSON Schema.
    const spec = provider.calls[0]!.tools![0]!;
    assert.equal(spec.name, "getWeather");
    assert.equal(spec.description, "Current weather for a city");
    assert.equal((spec.inputSchema as { type: string }).type, "object");
    assert.deepEqual((spec.inputSchema as { required: string[] }).required, ["city"]);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.for, "u1");
  });

  test("invalid input goes back to the model as a 422 so it can correct itself", async () => {
    let calls = 0;
    const counted = tool("count", { description: "Count", input: t.object({ n: t.int() }) }).handle(({ input }) => (calls++, input.n));
    const provider = mockProvider({
      respond: (r) => {
        const last = r.messages.at(-1)!;
        if (last.role !== "tool") return { toolCalls: [{ name: "count", input: { n: "three" } }] };
        if (last.isError) return { toolCalls: [{ name: "count", input: { n: 3 } }] };
        return `got ${last.content}`;
      },
    });
    const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
    const r = await ai.generate({ model: "fast", prompt: "count", tools: [counted] });
    assert.equal(r.text, "got 3");
    const first = r.steps[0]!.toolCalls[0]!;
    assert.equal(first.status, 422);
    assert.equal(first.isError, true);
    assert.equal((first.output as { error: { code: string } }).error.code, "IL1001");
    assert.equal(calls, 1);
  });

  test("httpError thrown by the function is sent to the model as a failed tool result", async () => {
    const find = tool("findOrder", { description: "Find an order", input: t.object({ id: t.string() }) }).handle(() => {
      throw httpError(404, "No order with that id.");
    });
    const ai = createAI({ providers: { mock: callsOnce("findOrder", { id: "x" }) }, models: { fast: "mock:m" } });
    const r = await ai.generate({ model: "fast", prompt: "find", tools: [find] });
    const call = r.steps[0]!.toolCalls[0]!;
    assert.equal(call.status, 404);
    assert.equal(call.isError, true);
    assert.match(r.text, /No order with that id/);
  });

  test("unexpected errors are not hidden: ai.generate rejects with the function's error, after recording usage", async () => {
    const usage: Usage[] = [];
    const broken = tool("broken", { description: "Fails", input: t.object({}) }).handle(() => {
      throw new Error("database is down");
    });
    const ai = createAI({ providers: { mock: callsOnce("broken", {}) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", tools: [broken] }), /database is down/);
    assert.equal(usage.length, 1);
  });

  test("strings are sent to the model as they are; the handler gets the call's signal", async () => {
    let signal: AbortSignal | undefined;
    const greet = tool("greet", { description: "Greet", input: t.object({ name: t.string() }) }).handle((ctx) => {
      signal = ctx.signal;
      return `Hello ${ctx.input.name}`;
    });
    const controller = new AbortController();
    const ai = createAI({ providers: { mock: callsOnce("greet", { name: "Ada" }) }, models: { fast: "mock:m" } });
    const r = await ai.generate({ model: "fast", prompt: "x", tools: [greet], signal: controller.signal });
    assert.equal(r.text, "Result: Hello Ada");
    assert.equal(r.steps[0]!.toolCalls[0]!.output, "Hello Ada");
    assert.equal(signal, controller.signal);
  });

  test("invalid definitions raise IL5013", () => {
    const bad = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL5013");
    bad(() => tool("get weather", { description: "x", input: t.object({}) }));
    bad(() => tool("getWeather", { description: "", input: t.object({}) }));
    bad(() => tool("getWeather", { description: "x", input: t.string() as never }));
    bad(() => tool("getWeather", { description: "x" } as never));
    bad(() => tool("getWeather", { description: "x", input: t.object({}) }).handle("nope" as never));
  });

  test("two tools with the same name in one call raise IL5013", async () => {
    const ai = createAI({ providers: { mock: callsOnce("getWeather", { city: "Oslo" }) }, models: { fast: "mock:m" } });
    const twin = tool("getWeather", { description: "Other", input: t.object({}) }).handle(() => 1);
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", tools: [getWeather, twin] }), (e: unknown) => e instanceof InferloError && e.code === "IL5013");
  });

  test("route tools still need a route handler (IL5009) even next to function tools", async () => {
    const r = route.get("/x").handle(() => 1);
    const ai = createAI({ providers: { mock: callsOnce("getWeather", { city: "Oslo" }) }, models: { fast: "mock:m" } });
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", tools: [getWeather, r] }), (e: unknown) => e instanceof InferloError && e.code === "IL5009");
  });

  test("ctx.ai mixes route tools and function tools in a route handler", async () => {
    const notes: string[] = [];
    const addNote = route.post("/notes", { body: t.object({ text: t.string() }), summary: "Add a note" }).handle(({ body, status }) => {
      status(201);
      notes.push(body.text);
      return { ok: true };
    });
    const provider = mockProvider({
      respond: (r) => {
        const toolMessages = r.messages.filter((m) => m.role === "tool").length;
        if (toolMessages === 0) return { toolCalls: [{ name: "getWeather", input: { city: "Rome" } }] };
        if (toolMessages === 1) return { toolCalls: [{ name: "addNote", input: { text: "Rome is 21c" } }] };
        return "Saved.";
      },
    });
    const agent = route.post("/agent", { body: t.object({ prompt: t.string() }) }).handle(async ({ ai, body, user }) => {
      const r = await ai.generate({ model: "fast", prompt: body.prompt, tools: [getWeather, addNote], for: user.id });
      return { text: r.text, calls: r.steps.flatMap((s) => s.toolCalls.map((c) => `${c.name}:${c.status}`)) };
    });
    const app = createApp({
      routes: [{ addNote, agent }],
      auth: bearer((token) => (token === "alice" ? { id: "alice", roles: [] } : null)),
      ai: { providers: { mock: provider }, models: { fast: "mock:m" } },
      logger: { info() {}, error() {} },
    });
    const res = await app.request("/agent", { method: "POST", headers: { authorization: "Bearer alice" }, json: { prompt: "note the weather in Rome" } });
    assert.deepEqual(await readJson(res, 200), { text: "Saved.", calls: ["getWeather:200", "addNote:201"] });
    assert.deepEqual(notes, ["Rome is 21c"]);
  });
});
