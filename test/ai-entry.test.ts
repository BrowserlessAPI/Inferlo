import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAI, mockProvider, t, InferloError, env, anthropic, openai, openaiCompatible, gemini, ollama, cosineSimilarity } from "../src/ai/public.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every module a file loads at runtime (type-only imports are erased and do not count). */
function runtimeGraph(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, "utf8");
  const pattern = /^(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["'](\.[^"']+)["']/gm;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) continue;
    const clause = match[0];
    // import { type A, type B } from "..." is erased too.
    const names = /\{([^}]*)\}/.exec(clause)?.[1];
    if (names && names.split(",").map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith("type "))) continue;
    runtimeGraph(path.resolve(path.dirname(file), match[2]!), seen);
  }
  return seen;
}

test("@browserlessapi/inferlo/ai is exported and maps to the standalone module", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./ai"], { types: "./dist/ai/public.d.ts", default: "./dist/ai/public.js" });
  assert.ok(existsSync(path.join(repo, "src/ai/public.ts")));
});

test("the AI entry point never loads the router, database, jobs or MCP code", () => {
  const files = [...runtimeGraph(path.join(repo, "src/ai/public.ts"))].map((f) => path.relative(path.join(repo, "src"), f)).sort();
  assert.deepEqual(files, ["ai/ai-sdk-model.ts", "ai/ai-sdk.ts", "ai/bedrock.ts", "ai/guardrails.ts", "ai/index.ts", "ai/providers.ts", "ai/public.ts", "ai/standard-schema.ts", "ai/tool.ts", "ai/ui.ts", "env.ts", "errors.ts", "redact.ts", "schema.ts", "sigv4.ts", "tracing.ts"]);
});

test("createAI works without createApp: aliases, fallback, structured output and usage", async () => {
  const usage: { model: string; for?: string }[] = [];
  const down = openai({ apiKey: "k", fetch: async () => new Response("overloaded", { status: 503 }) });
  const up = mockProvider({ respond: () => '{"label":"bug"}' });
  const ai = createAI({ providers: { down, up }, models: { fast: ["down:a", "up:b"] }, onUsage: (u) => void usage.push(u) });
  const { object } = await ai.generate({ model: "fast", prompt: "It crashes", output: t.object({ label: t.enum(["bug", "feature"]) }), for: "u1" });
  assert.equal(object.label, "bug");
  assert.equal(usage[0]?.model, "up:b");
  assert.equal(usage[0]?.for, "u1");
});

test("streaming and embeddings work from the AI entry point", async () => {
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => "Hello there" }) }, models: { fast: "mock:m", embed: "mock:e" } });
  let streamed = "";
  for await (const chunk of ai.stream({ model: "fast", prompt: "hi" })) streamed += chunk;
  assert.equal(streamed, "Hello there");
  const [a, b] = (await ai.embed({ model: "embed", input: ["x", "x"] })).embeddings;
  assert.equal(cosineSimilarity(a!, b!).toFixed(6), "1.000000");
});

test("route tools still need a route handler (IL5009); errors are InferloError", async () => {
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => "ok" }) }, models: { fast: "mock:m" } });
  const fakeRoute = { method: "GET", path: "/x" } as never;
  await assert.rejects(ai.generate({ model: "fast", prompt: "hi", tools: [fakeRoute] }), (e: unknown) => e instanceof InferloError && e.code === "IL5009");
});

test("providers and env are exported", () => {
  for (const fn of [anthropic, openai, openaiCompatible, gemini, ollama, env]) assert.equal(typeof fn, "function");
});
