import { route, t } from "@browserlessapi/inferlo";

export const faq = route
  .get("/faq", { query: t.object({ q: t.string().min(1).max(500) }), summary: "Answer a frequently asked question", rateLimit: { max: 60, per: "minute" } })
  .handle(async ({ ai, query, user }) => {
    const { text } = await ai.generate({ model: "fast", prompt: query.q, cache: { ttlMs: 3_600_000, tags: ["faq"] }, for: user.id });
    return { answer: text };
  });
