import { route, t } from "@browserlessapi/inferlo";

export const answer = route
  .post("/support/answer", { body: t.object({ question: t.string().min(1).max(10_000) }), summary: "Answer a support question", rateLimit: { max: 30, per: "minute" } })
  .handle(async ({ ai, body, user }) => {
    const { text } = await ai.generate({
      model: "fast",
      system: "You answer customer support questions briefly and politely.",
      prompt: body.question,
      guardrails: { redact: ["email", "card"], maxInputChars: 2000, maxTokens: 400, blockedTerms: ["refund is guaranteed"] },
      for: user.id,
    });
    return { answer: text };
  });
