import { Agent } from "@mastra/core/agent";
import { route, t, tool } from "@browserlessapi/inferlo";
import { toMastraModel, toMastraTools } from "@browserlessapi/inferlo/mastra";

export const orderStatus = tool("orderStatus", { description: "Status of an order", input: t.object({ orderId: t.string() }) }).handle(({ input }) => ({ orderId: input.orderId, status: "shipped" }));

export const support = route
  .post("/support", { body: t.object({ question: t.string().max(4000) }), rateLimit: { max: 20, per: "minute" } })
  .handle(async ({ body, ai, user }) => {
    // The agent's model calls use the app's "fast" alias, with its fallback, budgets and usage tracking.
    const agent = new Agent({
      id: "support",
      name: "Support",
      instructions: "You answer support questions.",
      model: toMastraModel(ai, { model: "fast", for: user.id }),
      tools: toMastraTools([orderStatus], { ai }),
    });
    const result = await agent.generate(body.question);
    return { answer: result.text };
  });
