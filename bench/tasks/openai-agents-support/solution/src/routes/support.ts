import { Agent, run } from "@openai/agents-core";
import { route, t } from "@browserlessapi/inferlo";
import { toOpenAIAgentsModel } from "@browserlessapi/inferlo/openai-agents";

export const support = route
  .post("/support", { body: t.object({ question: t.string().max(4000) }), rateLimit: { max: 20, per: "minute" } })
  .handle(async ({ body, ai, user }) => {
    // The agent's model calls use the app's "fast" alias, with its fallback, budgets and usage tracking.
    const agent = new Agent({ name: "Support", instructions: "You answer support questions.", model: toOpenAIAgentsModel(ai, { model: "fast", for: user.id }) });
    const result = await run(agent, body.question);
    return { answer: String(result.finalOutput ?? "") };
  });
