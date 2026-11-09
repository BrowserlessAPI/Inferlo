import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anthropic, createAI, gemini, ollama, t } from "../src/index.ts";

// Native structured output: ai.generate({ output }) sends the JSON Schema in each provider's own field, so the model
// is constrained to it (Anthropic's output_config.format, Gemini's and OpenAI's response_format json_schema).
// Inferlo still validates every answer and repairs it once.

const Triage = t.object({
  priority: t.enum(["low", "normal", "urgent"]),
  summary: t.string().min(5).max(300).describe("One sentence"),
  score: t.int().min(1).max(5),
  tags: t.array(t.string().max(20)).max(3),
  owner: t.object({ name: t.string().max(80) }).optional(),
});
const answer = { priority: "urgent", summary: "The site is down.", score: 5, tags: ["outage"] };

describe("native structured output", () => {
  test("Anthropic gets output_config.format with a schema it accepts, and the answer is validated", async () => {
    const bodies: Record<string, any>[] = [];
    const provider = anthropic({
      apiKey: "k",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init!.body)));
        return Response.json({ content: [{ type: "text", text: JSON.stringify(answer) }], usage: { input_tokens: 9, output_tokens: 7 } });
      },
    });
    const ai = createAI({ providers: { anthropic: provider }, models: { fast: "anthropic:claude-haiku-4-5" } });
    const { object } = await ai.generate({ model: "fast", prompt: "Site down!", output: Triage });
    assert.deepEqual(object, answer);
    const format = bodies[0]!.output_config.format;
    assert.equal(format.type, "json_schema");
    const schema = format.schema;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.owner.additionalProperties, false);
    assert.deepEqual(schema.properties.priority.enum, ["low", "normal", "urgent"]);
    assert.deepEqual(schema.required, ["priority", "summary", "score", "tags"]);
    // Limits Anthropic does not accept are moved into the description; Inferlo checks them itself.
    assert.equal(schema.properties.summary.minLength, undefined);
    assert.equal(schema.properties.summary.maxLength, undefined);
    assert.equal(schema.properties.summary.description, "One sentence (minLength: 5, maxLength: 300)");
    assert.equal(schema.properties.score.description, "(minimum: 1, maximum: 5)");
    assert.equal(schema.properties.tags.maxItems, undefined);
    assert.equal(schema.properties.tags.items.maxLength, undefined);
    assert.equal(JSON.stringify(schema).includes("$schema"), false);
    // Calls without output do not ask for structured output.
    await ai.generate({ model: "fast", prompt: "Hi" }).catch(() => {});
    assert.equal(bodies[1]!.output_config, undefined);
  });

  test("an Anthropic answer that breaks a limit is still repaired, and nativeStructuredOutput: false leaves it out", async () => {
    const bodies: Record<string, any>[] = [];
    const replies = [{ ...answer, score: 9 }, answer];
    const provider = anthropic({
      apiKey: "k",
      nativeStructuredOutput: false,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init!.body)));
        return Response.json({ content: [{ type: "text", text: JSON.stringify(replies.shift()) }], usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    const ai = createAI({ providers: { anthropic: provider }, models: { fast: "anthropic:claude-haiku-4-5" } });
    const { object } = await ai.generate({ model: "fast", prompt: "Site down!", output: Triage });
    assert.equal(object.score, 5);
    assert.equal(bodies.length, 2, "one repair round");
    assert.equal(bodies[0]!.output_config, undefined);
    assert.match(bodies[1]!.messages.at(-1).content, /score/);
  });

  test("Gemini gets response_format json_schema by default; other OpenAI-compatible servers keep json_object", async () => {
    const bodies: Record<string, any>[] = [];
    const fetch = async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    const ai = createAI({
      providers: { gemini: gemini({ apiKey: "g", fetch }), plain: gemini({ apiKey: "g", nativeStructuredOutput: false, fetch }), local: ollama({ fetch }) },
      models: { g: "gemini:gemini-2.5-flash", p: "plain:gemini-2.5-flash", l: "local:llama3" },
    });
    await ai.generate({ model: "g", prompt: "x", output: Triage });
    await ai.generate({ model: "p", prompt: "x", output: Triage });
    await ai.generate({ model: "l", prompt: "x", output: Triage });
    assert.equal(bodies[0]!.response_format.type, "json_schema");
    assert.equal(bodies[0]!.response_format.json_schema.schema.properties.priority.enum.length, 3);
    assert.deepEqual(bodies[1]!.response_format, { type: "json_object" });
    assert.deepEqual(bodies[2]!.response_format, { type: "json_object" });
  });
});
