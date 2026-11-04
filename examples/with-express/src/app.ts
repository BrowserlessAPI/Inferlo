// An existing Express app that adopts Inferlo step by step:
// 1. req.ai in Express handlers, from the inferloAI() middleware.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) mounted under /api.
import express from "express";
import { anthropic, createAI, env, t, type AIConfig } from "../../../src/ai/public.ts";
import { bearer, createApp, route, toNodeHandler } from "../../../src/index.ts";
import { inferloAI, sendResponse } from "../../../src/express.ts";

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
  const inferlo = createApp({ name: "with-express", routes: [{ summarize }], auth: bearer((token) => users.get(token) ?? null), ai: config });

  const server = express();
  server.use(express.json({ limit: "100kb" }));
  server.use(inferloAI(createAI(config)));

  // An existing Express route using Inferlo's AI module with structured output.
  server.post("/classify", async (req, res) => {
    const { object } = await req.ai.generate({ model: "fast", prompt: String(req.body?.text ?? ""), output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
    res.json(object);
  });

  // Streaming to the browser as server-sent events.
  server.get("/chat", (req, res) => sendResponse(res, req.ai.stream({ model: "fast", prompt: String(req.query.q ?? "") }).toResponse()));

  // New features live in Inferlo: /api/summaries, /api/openapi.json and /api/mcp.
  server.use("/api", toNodeHandler(inferlo));
  return server;
}
