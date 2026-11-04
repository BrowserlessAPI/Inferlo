// An existing Fastify app that adopts Inferlo step by step:
// 1. request.ai in Fastify handlers, from inferloPlugin.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) served under /api.
import Fastify from "fastify";
import { anthropic, createAI, env, t, type AIConfig } from "../../../src/ai/public.ts";
import { bearer, createApp, route } from "../../../src/index.ts";
import { inferloPlugin } from "../../../src/fastify.ts";

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

export async function makeServer(config: AIConfig = aiConfig) {
  const inferlo = createApp({ name: "with-fastify", routes: [{ summarize }], auth: bearer((token) => users.get(token) ?? null), ai: config });

  const fastify = Fastify();
  // fastify.ai and request.ai everywhere, and the Inferlo app under /api (/api/summaries, /api/openapi.json, /api/mcp).
  await fastify.register(inferloPlugin, { ai: createAI(config) });
  await fastify.register(inferloPlugin, { app: inferlo, prefix: "/api" });

  // An existing Fastify route using Inferlo's AI module with structured output.
  fastify.post<{ Body: { text: string } }>("/classify", async (request) => {
    const { object } = await request.ai.generate({ model: "fast", prompt: request.body.text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
    return object;
  });

  // Streaming to the browser as server-sent events: Fastify sends a Web Response as it is.
  fastify.get<{ Querystring: { q?: string } }>("/chat", (request, reply) => reply.send(request.ai.stream({ model: "fast", prompt: request.query.q ?? "" }).toResponse()));
  return fastify;
}
