// Standard Schema in the AI module: Zod, ArkType and Valibot schemas as ai.generate({ output }) and as tool input,
// shown to the model as the library's JSON Schema and validated by the library (Node.js, Bun and Deno).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { type } from "arktype";
import * as v from "valibot";
import { z } from "zod";
import * as standalone from "../src/ai/public.ts";
import { createAI, createApp, InferloError, mockProvider, route, t, tool, type StandardSchema } from "../src/index.ts";

const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const quiet = { info() {}, error() {} };

/** A provider that answers each structured-output call with the next reply, recording the requests. */
function replies(...answers: string[]) {
  let i = 0;
  return mockProvider({ respond: () => answers[Math.min(i++, answers.length - 1)]! });
}

const libraries: { name: string; triage: StandardSchema<{ priority: "low" | "high"; tags: string[]; summary?: string }> }[] = [
  { name: "Zod", triage: z.object({ priority: z.enum(["low", "high"]), tags: z.array(z.string()), summary: z.string().optional() }) },
  { name: "ArkType", triage: type({ priority: "'low' | 'high'", tags: "string[]", "summary?": "string" }) },
  { name: "Valibot", triage: toStandardJsonSchema(v.object({ priority: v.picklist(["low", "high"]), tags: v.array(v.string()), summary: v.optional(v.string()) })) },
];

for (const { name, triage } of libraries) {
  describe(`${name} schemas in the AI module`, () => {
    test("ai.generate({ output }) shows the model the library's JSON Schema and returns the validated object", async () => {
      const provider = replies('{"priority":"high","tags":["billing"]}');
      const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
      const { object } = await ai.generate({ model: "fast", prompt: "Triage: card declined", output: triage });
      const typed: { priority: "low" | "high"; tags: string[] } = object;
      assert.deepEqual(typed, { priority: "high", tags: ["billing"] });
      const request = provider.calls[0]!;
      assert.equal(request.json, true);
      const schema = request.jsonSchema as { type: string; properties: Record<string, unknown>; required: string[]; $schema?: string };
      assert.equal(schema.type, "object");
      assert.deepEqual(Object.keys(schema.properties).sort(), ["priority", "summary", "tags"]);
      assert.deepEqual([...schema.required].sort(), ["priority", "tags"]);
      assert.equal(schema.$schema, undefined, "the $schema keyword is left out for providers");
      assert.match(request.messages[0]!.content, /"priority"/, "the instruction carries the JSON Schema");
    });

    test("an answer that does not match is sent back with the library's issues, then IL5002", async () => {
      const provider = replies('{"priority":"urgent","tags":[]}', '{"priority":"low","tags":[]}');
      const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
      const { object } = await ai.generate({ model: "fast", prompt: "Triage", output: triage });
      assert.deepEqual(object, { priority: "low", tags: [] });
      assert.match(provider.calls[1]!.messages.at(-1)!.content, /That JSON does not match the schema: priority: /);

      const never = createAI({ providers: { mock: replies('{"tags":"x"}') }, models: { fast: "mock:m" } });
      await assert.rejects(never.generate({ model: "fast", prompt: "Triage", output: triage }), isCode("IL5002"));
    });

    test("a tool with the library's object schema as input gets validated, typed arguments", async () => {
      const seen: unknown[] = [];
      const fileTicket = tool("fileTicket", { description: "File a support ticket", input: triage }).handle(({ input }) => {
        const priority: "low" | "high" = input.priority;
        seen.push(input);
        return { id: 7, priority };
      });
      const provider = mockProvider({
        respond: (r) => {
          const last = r.messages.at(-1)!;
          if (last.role !== "tool") return { toolCalls: [{ name: "fileTicket", input: { priority: "urgent", tags: [] } }] };
          if (last.isError) return { toolCalls: [{ name: "fileTicket", input: { priority: "high", tags: ["vip"] } }] };
          return `done ${last.content}`;
        },
      });
      const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
      const r = await ai.generate({ model: "fast", prompt: "File it", tools: [fileTicket] });
      assert.equal(r.text, 'done {"id":7,"priority":"high"}');
      assert.equal(r.steps[0]!.toolCalls[0]!.status, 422, "invalid arguments go back to the model as a 422");
      assert.equal((r.steps[0]!.toolCalls[0]!.output as { error: { code: string } }).error.code, "IL1001");
      assert.deepEqual(seen, [{ priority: "high", tags: ["vip"] }], "the function only runs with valid input");
      const spec = provider.calls[0]!.tools![0]!.inputSchema as { type: string; properties: Record<string, unknown> };
      assert.equal(spec.type, "object");
      assert.ok("priority" in spec.properties);
    });
  });
}

describe("Standard Schema rules", () => {
  test("Zod transforms and defaults apply to the result", async () => {
    const ai = createAI({ providers: { mock: replies('{"title":"  Refund  "}') }, models: { fast: "mock:m" } });
    const { object } = await ai.generate({ model: "fast", prompt: "x", output: z.object({ title: z.string().trim(), status: z.string().default("open") }) });
    assert.deepEqual(object, { title: "Refund", status: "open" });
  });

  test("ctx.ai in a route takes Zod schemas too", async () => {
    const summarize = route.post("/summaries", { auth: "public", body: t.object({ text: t.string() }) }).handle(async ({ ai, body }) => {
      const { object } = await ai.generate({ prompt: body.text, output: z.object({ summary: z.string() }) });
      return object;
    });
    const app = createApp({ routes: [{ summarize }], ai: { providers: { mock: replies('{"summary":"short"}') }, models: { fast: "mock:m" } }, logger: quiet });
    const res = await app.request("/summaries", { method: "POST", json: { text: "long text" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { summary: "short" });
  });

  test("an output that is not a schema, or a Standard Schema without JSON Schema, is IL5032 before any model call", async () => {
    const provider = replies("{}");
    const ai = createAI({ providers: { mock: provider }, models: { fast: "mock:m" } });
    const plainValibot = v.object({ a: v.string() });
    for (const output of [{ type: "object" }, "json", plainValibot]) {
      await assert.rejects(ai.generate({ model: "fast", prompt: "x", output: output as never }), isCode("IL5032"));
    }
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", output: plainValibot as never }), /toStandardJsonSchema/);
    assert.equal(provider.calls.length, 0);
  });

  test("a schema that cannot be JSON Schema is IL5032 with the reason", async () => {
    const ai = createAI({ providers: { mock: replies("{}") }, models: { fast: "mock:m" } });
    await assert.rejects(ai.generate({ model: "fast", prompt: "x", output: z.object({ at: z.date() }) }), (e: unknown) => isCode("IL5032")(e) && /cannot be turned into JSON Schema/.test((e as Error).message));
  });

  test("tool input must be an object schema with JSON Schema (IL5013)", () => {
    assert.throws(() => tool("t1", { description: "d", input: z.string() as never }), (e: unknown) => isCode("IL5013")(e) && /object schema/.test((e as Error).message));
    assert.throws(() => tool("t2", { description: "d", input: v.object({ a: v.string() }) as never }), (e: unknown) => isCode("IL5013")(e) && /Standard JSON Schema/.test((e as Error).message));
    assert.throws(() => tool("t3", { description: "d", input: { a: "string" } as never }), isCode("IL5013"));
    assert.doesNotThrow(() => tool("t4", { description: "d", input: z.object({ a: z.string() }) }));
  });

  test("works from @browserlessapi/inferlo/ai", async () => {
    const ai = standalone.createAI({ providers: { mock: replies('{"ok":true}') }, models: { fast: "mock:m" } });
    const { object } = await ai.generate({ model: "fast", prompt: "x", output: z.object({ ok: z.boolean() }) });
    assert.equal(object.ok, true);
  });
});
