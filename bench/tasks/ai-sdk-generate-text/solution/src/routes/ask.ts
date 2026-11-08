import { generateText, stepCountIs } from "ai";
import { route, t, toAISdkModel, toAISdkTools, tool } from "@browserlessapi/inferlo";

export const orderStatus = tool("orderStatus", { description: "Status of an order", input: t.object({ orderId: t.string() }) }).handle(({ input }) => ({ orderId: input.orderId, status: "shipped" }));

export const ask = route
  .post("/ask", { body: t.object({ question: t.string().max(4000) }), rateLimit: { max: 20, per: "minute" } })
  .handle(async ({ body, ai, user }) => {
    // The model calls use the app's "fast" alias, with its fallback, budgets and usage tracking.
    const { text } = await generateText({
      model: toAISdkModel(ai, { model: "fast", for: user.id }),
      tools: toAISdkTools([orderStatus], { ai }),
      stopWhen: stepCountIs(5),
      system: "You answer support questions.",
      prompt: body.question,
    });
    return { answer: text };
  });
