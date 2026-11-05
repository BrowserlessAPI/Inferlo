// An existing hapi app that adopts Inferlo step by step:
// 1. request.ai in hapi handlers, from inferloPlugin.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) served under /api.
import Hapi from "@hapi/hapi";
import { anthropic, createAI, env, t, type AIConfig } from "../../../src/ai/public.ts";
import { inferloPlugin } from "../../../src/hapi.ts";
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

const chat = route
  .get("/chat", { auth: "public", query: t.object({ q: t.string().min(1).max(2_000) }) })
  .handle(({ query, ai }) => ai.stream({ model: "fast", prompt: query.q }).toResponse());

export async function makeServer(config: AIConfig = aiConfig, port = 3000) {
  const inferlo = createApp({ name: "with-hapi", routes: [{ summarize, chat }], auth: bearer((token) => users.get(token) ?? null), ai: config });

  const server = Hapi.server({ port, host: "0.0.0.0" });
  // server.ai and request.ai everywhere, and the Inferlo app under /api (/api/summaries, /api/openapi.json, /api/mcp).
  await server.register({ plugin: inferloPlugin, options: { ai: createAI(config) } });
  await server.register({ plugin: inferloPlugin, options: { app: inferlo }, routes: { prefix: "/api" } });

  // An existing hapi route using Inferlo's AI module with structured output.
  server.route({
    method: "POST",
    path: "/classify",
    handler: async (request) => {
      const { text } = request.payload as { text: string };
      const { object } = await request.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
      return object;
    },
  });
  return server;
}
