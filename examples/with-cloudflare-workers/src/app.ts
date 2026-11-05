// The Inferlo app the Worker serves: config from Worker bindings, auth, validation, rate limits, AI, OpenAPI and MCP.
import { anthropic, bearer, config, createApp, route, t } from "../../../src/index.ts";

// Read once when the Worker starts. With the nodejs_compat flag (compatibility date 2025-04-01 or later),
// Worker vars and secrets are environment variables, so config() and env() read them.
export const settings = config({
  schema: t.object({
    ANTHROPIC_API_KEY: t.string().default(""),
    API_TOKEN: t.string().min(16),
  }),
  secrets: ["ANTHROPIC_API_KEY", "API_TOKEN"],
});

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

export const app = createApp({
  name: "with-cloudflare-workers",
  routes: [{ summarize, chat, status }],
  // One API token from a Worker secret (wrangler secret put API_TOKEN).
  auth: bearer((token) => (token === settings.API_TOKEN ? { id: "00000000-0000-4000-8000-000000000001", roles: [] } : null)),
  ai: {
    providers: { anthropic: anthropic({ apiKey: settings.ANTHROPIC_API_KEY }) },
    models: { fast: "anthropic:claude-haiku-4-5" },
  },
  redact: [settings],
});
