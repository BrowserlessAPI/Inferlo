// New features live in an Inferlo app: /api/summaries, /api/openapi.json and /api/mcp.
import { t, type AIConfig } from "../../../src/ai/public.ts";
import { bearer, createApp, route } from "../../../src/index.ts";
import { aiConfig } from "./ai.ts";

const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001", roles: [] as string[] }]]);

const summarize = route
  .post("/summaries", { body: t.object({ text: t.string().min(1).max(20_000) }), rateLimit: { max: 20, per: "hour" }, tool: true })
  .handle(async ({ body, ai, user }) => {
    const { text } = await ai.generate({ model: "fast", prompt: `Summarize in one sentence:\n\n${body.text}`, for: user.id });
    return { summary: text };
  });

export const makeInferlo = (config: AIConfig = aiConfig) => createApp({ name: "with-tsed", routes: [{ summarize }], auth: bearer((token) => users.get(token) ?? null), ai: config });
