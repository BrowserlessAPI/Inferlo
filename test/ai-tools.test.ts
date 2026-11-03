import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anthropic, bearer, createApp, InferloError, mockProvider, openai, ProviderError, route, t, type Provider, type Usage } from "../src/index.ts";
import { readJson } from "../src/testing.ts";

const ALICE = { id: "alice", roles: ["admin"] };
const BOB = { id: "bob", roles: [] as string[] };

function setup(provider: Provider, onUsage?: (u: Usage) => void) {
  const notes: { title: string; ownerId: string }[] = [];
  const createNote = route
    .post("/notes", { body: t.object({ title: t.string().min(1).max(50) }), summary: "Create a note for the signed-in user" })
    .handle(({ body, user, status }) => {
      status(201);
      const note = { title: body.title, ownerId: user.id };
      notes.push(note);
      return note;
    });
  const getNote = route.get("/notes/:index", { params: t.object({ index: t.int() }), summary: "Get one note" }).handle(({ params }) => notes[params.index] ?? null);
  const wipe = route.delete("/notes", { auth: "admin", summary: "Delete every note" }).handle(() => void notes.splice(0));
  const notRegistered = route.get("/secret").handle(() => "secret");
  const agent = route
    .post("/agent", { body: t.object({ prompt: t.string(), maxSteps: t.int().optional(), unregistered: t.boolean().optional() }) })
    .handle(async ({ ai, body, user }) => {
      const r = await ai.generate({
        model: "fast",
        prompt: body.prompt,
        tools: body.unregistered ? [notRegistered] : [createNote, getNote, wipe],
        maxSteps: body.maxSteps,
        for: user.id,
      });
      return { text: r.text, steps: r.steps, usage: r.usage };
    });
  const app = createApp({
    routes: [{ createNote, getNote, wipe, agent }],
    auth: bearer((token) => (token === "alice" ? ALICE : token === "bob" ? BOB : null)),
    ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage },
    logger: { info() {}, error() {} },
  });
  return { app, notes };
}

describe("ai tools", () => {
  test("the model calls routes as tools as the current user, and usage is tracked per step", async () => {
    const usage: Usage[] = [];
    const provider = mockProvider({
      respond: (r) => (r.messages.at(-1)!.role === "tool" ? "Created your note." : { toolCalls: [{ name: "createNote", input: { title: "Buy milk" } }] }),
    });
    const { app, notes } = setup(provider, (u) => void usage.push(u));
    const out = await readJson(await app.request("/agent", { method: "POST", json: { prompt: "Remember to buy milk" }, as: BOB }), 200);
    assert.equal(out.text, "Created your note.");
    assert.deepEqual(notes, [{ title: "Buy milk", ownerId: "bob" }]);
    assert.equal(out.steps.length, 2);
    assert.deepEqual(out.steps[0].toolCalls[0], { id: "call_1_1", name: "createNote", input: { title: "Buy milk" }, status: 201, output: { title: "Buy milk", ownerId: "bob" }, isError: false });
    assert.deepEqual(out.steps[1].toolCalls, []);
    assert.equal(out.usage.inputTokens, out.steps[0].usage.inputTokens + out.steps[1].usage.inputTokens);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.for, "bob");

    // The model saw the tools with their JSON Schemas, and the tool result on the second call.
    const tools = provider.calls[0]!.tools!;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["createNote", "getNote", "wipe"],
    );
    assert.equal(tools[0]!.description, "Create a note for the signed-in user");
    assert.deepEqual((tools[0]!.inputSchema as { required: string[] }).required, ["title"]);
    assert.deepEqual((tools[1]!.inputSchema as { required: string[] }).required, ["index"]);
    const last = provider.calls[1]!.messages;
    assert.equal(last.at(-2)!.role, "assistant");
    assert.equal(last.at(-2)!.toolCalls![0]!.name, "createNote");
    assert.deepEqual(last.at(-1), { role: "tool", toolCallId: "call_1_1", content: '{"title":"Buy milk","ownerId":"bob"}' });
  });

  test("route auth, roles and validation apply to tool calls, and errors go back to the model", async () => {
    const provider = mockProvider({
      respond: (r) =>
        r.messages.at(-1)!.role === "tool"
          ? "Could not do that."
          : { toolCalls: [{ name: "wipe" }, { name: "createNote", input: { title: "" } }, { name: "dropTables", input: {} }, { name: "getNote", input: { index: "0" } }] },
    });
    const { app, notes } = setup(provider);
    notes.push({ title: "keep", ownerId: "alice" });
    const out = await readJson(await app.request("/agent", { method: "POST", json: { prompt: "delete everything" }, headers: { authorization: "Bearer bob" } }), 200);
    const calls = out.steps[0].toolCalls;
    assert.equal(calls[0].status, 403);
    assert.equal(calls[0].isError, true);
    assert.equal(calls[0].output.error.code, "IL3002");
    assert.equal(calls[1].status, 422);
    assert.equal(calls[1].output.error.code, "IL1001");
    assert.equal(calls[2].status, 404);
    assert.match(calls[2].output, /Unknown tool "dropTables". Available tools: createNote, getNote, wipe/);
    assert.equal(calls[3].status, 200);
    assert.deepEqual(calls[3].output, { title: "keep", ownerId: "alice" });
    assert.equal(notes.length, 1);
    const toolMessages = provider.calls[1]!.messages.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 4);
    assert.equal(toolMessages[0]!.isError, true);
    assert.equal(toolMessages[3]!.isError, undefined);

    // The same tool works for an admin.
    const admin = mockProvider({ respond: (r) => (r.messages.at(-1)!.role === "tool" ? "Done." : { toolCalls: [{ name: "wipe" }] }) });
    const second = setup(admin);
    second.notes.push({ title: "x", ownerId: "alice" });
    const done = await readJson(await second.app.request("/agent", { method: "POST", json: { prompt: "wipe" }, headers: { authorization: "Bearer alice" } }), 200);
    assert.equal(done.steps[0].toolCalls[0].status, 204);
    assert.equal(second.notes.length, 0);
  });

  test("the step limit stops a model that keeps calling tools with IL5010", async () => {
    const usage: Usage[] = [];
    const provider = mockProvider({ respond: () => ({ toolCalls: [{ name: "createNote", input: { title: "again" } }] }) });
    const { app, notes } = setup(provider, (u) => void usage.push(u));
    const res = await app.request("/agent", { method: "POST", json: { prompt: "loop", maxSteps: 3 }, as: BOB });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "IL5010");
    assert.equal(provider.calls.length, 3);
    assert.equal(notes.length, 2);
    assert.equal(usage.length, 1);
  });

  test("tools only work through ctx.ai (IL5009) and must be registered routes (IL5011)", async () => {
    const provider = mockProvider({ respond: () => "x" });
    const { app } = setup(provider);
    const createNote = app.routes.find((r) => r.name === "createNote")!;
    await assert.rejects(app.ai.generate({ prompt: "x", tools: [createNote] }), (e: unknown) => e instanceof InferloError && e.code === "IL5009");
    const res = await app.request("/agent", { method: "POST", json: { prompt: "x", unregistered: true }, as: BOB });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "IL5011");
  });

  test("structured output works after tool calls", async () => {
    const provider = mockProvider({
      respond: (r) => (r.messages.at(-1)!.role === "tool" ? '{"count":1}' : { toolCalls: [{ name: "getNote", input: { index: 0 } }] }),
    });
    const counter = route.post("/count", { auth: "public" }).handle(async ({ ai }) => {
      const { object, steps } = await ai.generate({ model: "fast", prompt: "count", output: t.object({ count: t.int() }), tools: [getNote] });
      return { object, steps: steps.length };
    });
    const getNote = route.get("/notes/:index", { auth: "public", params: t.object({ index: t.int() }) }).handle(({ params }) => ({ index: params.index }));
    const app = createApp({ routes: [{ counter, getNote }], ai: { providers: { mock: provider }, models: { fast: "mock:m" } } });
    assert.deepEqual(await readJson(await app.request("/count", { method: "POST" }), 200), { object: { count: 1 }, steps: 2 });
  });

  test("no fallback to another model once a tool has run", async () => {
    // The first model calls a tool, then fails with a retryable error on its next call.
    const flaky = mockProvider({ respond: () => ({ toolCalls: [{ name: "createNote", input: { title: "once" } }] }) });
    const failingSecond: Provider = {
      name: "flaky",
      async generate(r) {
        if (r.messages.some((m) => m.role === "tool")) throw new ProviderError("flaky", 503, "overloaded");
        return flaky.generate(r);
      },
    };
    const backup = mockProvider({ respond: () => ({ toolCalls: [{ name: "createNote", input: { title: "twice" } }] }) });
    const notes: string[] = [];
    const createNote = route.post("/notes", { auth: "public", body: t.object({ title: t.string() }) }).handle(({ body }) => void notes.push(body.title));
    const agent = route.post("/agent", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "fast", prompt: "go", tools: [createNote] })).text);
    const app = createApp({
      routes: [{ createNote, agent }],
      ai: { providers: { flaky: failingSecond, backup }, models: { fast: ["flaky:a", "backup:b"] } },
      logger: { info() {}, error() {} },
    });
    const res = await app.request("/agent", { method: "POST" });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.code, "IL5006");
    assert.deepEqual(notes, ["once"]);
    assert.equal(backup.calls.length, 0);
  });

  test("anthropic tool_use and tool_result shapes", async () => {
    const bodies: any[] = [];
    const provider = anthropic({
      apiKey: "k",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (bodies.length === 1) {
          return Response.json({
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "toolu_1", name: "getNote", input: { index: 0 } },
              { type: "tool_use", id: "toolu_2", name: "getNote", input: { index: 1 } },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }
        return Response.json({ content: [{ type: "text", text: "Two notes." }], usage: { input_tokens: 20, output_tokens: 3 } });
      },
    });
    const getNote = route.get("/notes/:index", { auth: "public", params: t.object({ index: t.int() }), summary: "Get a note" }).handle(({ params }) => ({ index: params.index }));
    const agent = route.post("/agent", { auth: "public" }).handle(async ({ ai }) => {
      const r = await ai.generate({ model: "fast", system: "Be brief.", prompt: "How many notes?", tools: [getNote] });
      return { text: r.text, usage: r.usage, steps: r.steps.length };
    });
    const app = createApp({ routes: [{ getNote, agent }], ai: { providers: { anthropic: provider }, models: { fast: "anthropic:claude-haiku-4-5" } } });
    const out = await readJson(await app.request("/agent", { method: "POST" }), 200);
    assert.equal(out.text, "Two notes.");
    assert.equal(out.usage.inputTokens, 30);
    assert.equal(out.steps, 2);
    assert.deepEqual(bodies[0].tools, [
      { name: "getNote", description: "Get a note", input_schema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } },
    ]);
    assert.equal(bodies[1].system, "Be brief.");
    assert.deepEqual(bodies[1].messages, [
      { role: "user", content: "How many notes?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "toolu_1", name: "getNote", input: { index: 0 } },
          { type: "tool_use", id: "toolu_2", name: "getNote", input: { index: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: '{"index":0}' },
          { type: "tool_result", tool_use_id: "toolu_2", content: '{"index":1}' },
        ],
      },
    ]);
  });

  test("openai tool_calls and tool message shapes", async () => {
    const bodies: any[] = [];
    const provider = openai({
      apiKey: "k",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) {
          return Response.json({
            choices: [{ message: { content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "getNote", arguments: '{"index":2}' } }, { id: "call_b", type: "function", function: { name: "getNote", arguments: "{oops" } }] } }],
            usage: { prompt_tokens: 7, completion_tokens: 4 },
          });
        }
        return Response.json({ choices: [{ message: { content: "Note 2." } }], usage: { prompt_tokens: 9, completion_tokens: 2 } });
      },
    });
    const getNote = route.get("/notes/:index", { auth: "public", params: t.object({ index: t.int() }) }).handle(({ params }) => ({ index: params.index }));
    const agent = route.post("/agent", { auth: "public" }).handle(async ({ ai }) => {
      const r = await ai.generate({ model: "fast", prompt: "Read note 2", tools: [getNote] });
      return { text: r.text, calls: r.steps[0]!.toolCalls };
    });
    const app = createApp({ routes: [{ getNote, agent }], ai: { providers: { openai: provider }, models: { fast: "openai:gpt-5-mini" } } });
    const out = await readJson(await app.request("/agent", { method: "POST" }), 200);
    assert.equal(out.text, "Note 2.");
    assert.equal(out.calls[1].status, 422);
    assert.deepEqual(bodies[0].tools, [{ type: "function", function: { name: "getNote", description: "GET /notes/:index", parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } } }]);
    assert.deepEqual(bodies[1].messages.slice(1), [
      { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "getNote", arguments: '{"index":2}' } }, { id: "call_b", type: "function", function: { name: "getNote", arguments: '"{oops"' } }] },
      { role: "tool", tool_call_id: "call_a", content: '{"index":2}' },
      { role: "tool", tool_call_id: "call_b", content: "Tool arguments must be a JSON object." },
    ]);
  });
});
