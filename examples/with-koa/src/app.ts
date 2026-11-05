// An existing Koa app that adopts Inferlo step by step:
// 1. ctx.ai in Koa middleware, from the inferloAI() middleware.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) mounted under /api.
import Koa from "koa";
import { anthropic, createAI, env, t, type AIConfig } from "../../../src/ai/public.ts";
import { bearer, createApp, route } from "../../../src/index.ts";
import { inferloAI, sendResponse, toKoaMiddleware } from "../../../src/koa.ts";

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

export function makeServer(config: AIConfig = aiConfig) {
  const inferlo = createApp({ name: "with-koa", routes: [{ summarize }], auth: bearer((token) => users.get(token) ?? null), ai: config });

  const koa = new Koa();
  koa.use(inferloAI(createAI(config)));

  // New features live in Inferlo: /api/summaries, /api/openapi.json and /api/mcp. Other paths go on to Koa.
  koa.use(toKoaMiddleware(inferlo, { prefix: "/api" }));

  // Existing Koa middleware using Inferlo's AI module.
  koa.use(async (ctx) => {
    if (ctx.method === "GET" && ctx.path === "/classify") {
      const { object } = await ctx.ai.generate({ model: "fast", prompt: String(ctx.query.text ?? ""), output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
      ctx.body = object;
    } else if (ctx.method === "GET" && ctx.path === "/chat") {
      // Streaming to the browser as server-sent events.
      await sendResponse(ctx, ctx.ai.stream({ model: "fast", prompt: String(ctx.query.q ?? "") }).toResponse());
    } else {
      ctx.status = 404;
      ctx.body = { error: "Not found" };
    }
  });
  return koa;
}
