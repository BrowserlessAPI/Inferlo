import { route, t } from "@browserlessapi/inferlo";

export const assistant = route
  .ws("/assistant", { message: t.object({ question: t.string().min(1).max(2000) }), summary: "Ask the assistant" })
  .handle(async ({ message, ai, socket, user }) => {
    await socket.stream(ai.stream({ model: "fast", prompt: message.question, for: user.id }));
  });
