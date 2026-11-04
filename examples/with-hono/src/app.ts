// An existing Hono app that adopts Inferlo step by step:
// 1. c.var.ai in Hono handlers, from the inferloAI() middleware.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) mounted under /api.
import { Hono } from "hono";
import { anthropic, createAI, env, t, type AIConfig } from "../../../src/ai/public.ts";
import { bearer, createApp, route } from "../../../src/index.ts";
import { inferloAI, type InferloVariables } from "../../../src/hono.ts";

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

const summarize = route
  .post("/summaries", { body: t.object({ text: t.string().min(1).max(20_000) }), rateLimit: { max: 20, per: "hour" }, tool: true })
  .handle(async ({ body, ai, user }) => {
    const { text } = await ai.generate({ model: "fast", prompt: `Summarize in one sentence:\n\n${body.text}`, for: user.id });
    return { summary: text };
  });

export function makeHono(config: AIConfig = aiConfig) {
  const inferlo = createApp({ name: "with-hono", routes: [{ summarize }], auth: bearer((token) => users.get(token) ?? null), ai: config });

  const hono = new Hono<{ Variables: InferloVariables }>();
  hono.use(inferloAI(createAI(config)));

  // An existing Hono route using Inferlo's AI module with structured output.
  hono.post("/classify", async (c) => {
    const { text } = await c.req.json<{ text: string }>();
    const { object } = await c.var.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
    return c.json(object);
  });

  // New features live in Inferlo: /api/summaries, /api/openapi.json and /api/mcp.
  hono.mount("/api", inferlo.fetch);
  return hono;
}
