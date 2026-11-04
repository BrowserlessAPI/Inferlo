// An existing Elysia app that adopts Inferlo step by step:
// 1. ({ ai }) in Elysia handlers, from the inferloAI() plugin.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) mounted under /api.
import { Elysia } from "elysia";
import { anthropic, createAI, env, t, type AIConfig } from "../../../src/ai/public.ts";
import { inferloAI } from "../../../src/elysia.ts";
import { bearer, createApp, route } from "../../../src/index.ts";

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

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

export function makeElysia(config: AIConfig = aiConfig) {
  const inferlo = createApp({ name: "with-elysia", routes: [{ summarize }], auth: bearer((token) => users.get(token) ?? null), ai: config });

  return (
    new Elysia()
      .use(inferloAI(createAI(config)))
      // An existing Elysia route using Inferlo's AI module with structured output.
      .post("/classify", async ({ ai, body }) => {
        const { text } = body as { text: string };
        const { object } = await ai.generate({ model: "fast", prompt: text, output: Label });
        return object;
      })
      // New features live in Inferlo: /api/summaries, /api/openapi.json and /api/mcp.
      .mount("/api", inferlo.fetch)
  );
}
