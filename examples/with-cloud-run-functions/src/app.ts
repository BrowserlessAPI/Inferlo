// The Inferlo app the Cloud Run function serves: auth, validation, rate limits, OpenAPI and MCP.
import { anthropic, bearer, createApp, env, route, t, type AIConfig } from "../../../src/index.ts";

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

export const status = route.get("/status", { auth: "public" }).handle(() => ({ ok: true }));

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export function makeApp(config: AIConfig = aiConfig) {
  return createApp({ name: "with-cloud-run-functions", routes: [{ summarize, chat, status }], auth: bearer((token) => users.get(token) ?? null), ai: config });
}

export const app = makeApp();
