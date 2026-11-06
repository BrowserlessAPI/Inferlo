import { fromUIMessages, route, uiChatBody } from "@browserlessapi/inferlo";

export const chat = route
  .post("/chat", { body: uiChatBody })
  .handle(({ body, ai, user }) => ai.stream({ model: "fast", messages: fromUIMessages(body.messages), for: user.id }).toResponse({ format: "ai-sdk" }));
