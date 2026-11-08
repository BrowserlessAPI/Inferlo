import { LLMAgent } from "@llamaindex/core/agent";
import { route, t, tool } from "@browserlessapi/inferlo";
import { toLlamaIndexLLM, toLlamaIndexTools } from "@browserlessapi/inferlo/llamaindex";

export const orderStatus = tool("orderStatus", { description: "Status of an order", input: t.object({ orderId: t.string() }) }).handle(({ input }) => ({
  orderId: input.orderId,
  status: "shipped",
}));

export const support = route
  .post("/support", { body: t.object({ question: t.string().max(4000) }) })
  .handle(async ({ body, ai, user }) => {
    // The agent's model calls go through ctx.ai: Inferlo's aliases, fallback, budgets and usage tracking.
    const agent = new LLMAgent({
      llm: toLlamaIndexLLM(ai, { model: "fast", for: user.id }),
      tools: toLlamaIndexTools([orderStatus]),
      systemPrompt: "You answer support questions.",
    });
    const response = await agent.chat({ message: body.question });
    return { answer: String(response.message.content) };
  });
