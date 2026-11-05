// The Inferlo app served by the catch-all route server/routes/api/[...path].ts: auth, validation, rate limits,
// OpenAPI and MCP for the new API, next to the Nitro (or Nuxt) server routes that already exist.
import { anthropic, env, t } from "../../../../src/ai/public.ts";
import { bearer, createApp, route } from "../../../../src/index.ts";

const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

export const summarize = route
  .post("/summaries", { body: t.object({ text: t.string().min(1).max(20_000) }), rateLimit: { max: 20, per: "hour" }, tool: true })
  .handle(async ({ body, ai, user }) => {
    const { text } = await ai.generate({ model: "fast", prompt: `Summarize in one sentence:\n\n${body.text}`, for: user.id });
    return { summary: text };
  });

export const health = route.get("/status", { auth: "public" }).handle(() => ({ ok: true }));

export const app = createApp({
  name: "with-nitro",
  routes: [{ summarize, health }],
  auth: bearer((token) => users.get(token) ?? null),
  ai: {
    providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
    models: { fast: "anthropic:claude-haiku-4-5" },
  },
});
