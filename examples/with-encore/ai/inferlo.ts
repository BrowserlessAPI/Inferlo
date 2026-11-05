// A whole Inferlo app (auth, validation, rate limits, OpenAPI and MCP) that the raw endpoint in api.ts serves
// under /inferlo. Its routes use the same AI configuration as the Encore endpoints.
import { t } from "../../../src/ai/public.ts";
import { bearer, createApp, route } from "../../../src/index.ts";
import { aiConfig } from "./ai.ts";

const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

export const summarize = route
  .post("/summaries", { body: t.object({ text: t.string().min(1).max(20_000) }), rateLimit: { max: 20, per: "hour" }, tool: true })
  .handle(async ({ body, ai, user }) => {
    const { text } = await ai.generate({ model: "fast", prompt: `Summarize in one sentence:\n\n${body.text}`, for: user.id });
    return { summary: text };
  });

export const inferlo = createApp({ name: "with-encore", routes: [{ summarize }], auth: bearer((token) => users.get(token) ?? null), ai: aiConfig });
