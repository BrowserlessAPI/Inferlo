import { route, t } from "@browserlessapi/inferlo";
import { toLangChainModel } from "@browserlessapi/inferlo/langchain";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export const assistant = route
  .post("/assistant", { body: t.object({ message: t.string().max(4000) }), rateLimit: { max: 20, per: "minute" } })
  .handle(async ({ body, ai, user }) => {
    // The model uses the app's "fast" alias, with its fallback, budgets and usage tracking.
    const model = toLangChainModel(ai, { model: "fast", for: user.id });
    const reply = await model.invoke([new SystemMessage("You are a helpful assistant."), new HumanMessage(body.message)]);
    return { answer: typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content) };
  });
