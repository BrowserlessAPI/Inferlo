// The Inferlo app the function serves: auth, validation, rate limits by client address, AI, OpenAPI and MCP.
import { anthropic, bearer, createApp, env, route, t, type AIConfig } from "../../../src/index.ts";

const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

export const summarize = route
  .post("/api/summaries", { body: t.object({ text: t.string().min(1).max(20_000) }), rateLimit: { max: 20, per: "hour" }, tool: true })
  .handle(async ({ body, ai, user }) => {
    const { text } = await ai.generate({ model: "fast", prompt: `Summarize in one sentence:\n\n${body.text}`, for: user.id });
    return { summary: text };
  });

export const chat = route
  .get("/api/chat", { query: t.object({ q: t.string().min(1).max(2_000) }) })
  .handle(({ query, ai, user }) => ai.stream({ model: "fast", prompt: query.q, for: user.id }).toResponse());

// Public, so limited per client address (the address Netlify sets, not a header the client can send).
export const status = route.get("/api/status", { auth: "public", rateLimit: { max: 60, per: "minute", by: "ip" } }).handle(() => ({ ok: true }));

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export function makeApp(config: AIConfig = aiConfig) {
  return createApp({ name: "with-netlify", routes: [{ summarize, chat, status }], auth: bearer((token) => users.get(token) ?? null), ai: config });
}

export const app = makeApp();
