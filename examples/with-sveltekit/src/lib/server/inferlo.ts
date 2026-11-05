// The Inferlo app behind /api: auth, validation, rate limits, OpenAPI and MCP, served by
// src/routes/api/[...path]/+server.ts.
import { t, type AIConfig } from "../../../../../src/ai/public.ts";
import { bearer, createApp, route } from "../../../../../src/index.ts";
import { aiConfig } from "./ai.ts";

const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

export const summarize = route
  .post("/summaries", { body: t.object({ text: t.string().min(1).max(20_000) }), rateLimit: { max: 20, per: "hour" }, tool: true })
  .handle(async ({ body, ai, user }) => {
    const { text } = await ai.generate({ model: "fast", prompt: `Summarize in one sentence:\n\n${body.text}`, for: user.id });
    return { summary: text };
  });

export const chat = route
  .get("/chat", { query: t.object({ q: t.string().min(1).max(2_000) }) })
  .handle(({ query, ai, user }) => ai.stream({ model: "fast", prompt: query.q, for: user.id }).toResponse());

export function makeApp(config: AIConfig = aiConfig) {
  return createApp({ name: "with-sveltekit", routes: [{ summarize, chat }], auth: bearer((token) => users.get(token) ?? null), ai: config });
}

export const app = makeApp();
