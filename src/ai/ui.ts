/**
 * Chat UIs built with the Vercel AI SDK (useChat from @ai-sdk/react, @ai-sdk/vue, @ai-sdk/svelte):
 *
 *   route.post("/chat", { body: uiChatBody }).handle(({ body, ai, user }) =>
 *     ai.stream({ model: "fast", messages: fromUIMessages(body.messages), for: user.id }).toResponse({ format: "ai-sdk" }))
 *
 * uiChatBody validates the body useChat sends, fromUIMessages turns its messages into model messages, and
 * toResponse({ format: "ai-sdk" }) answers with the AI SDK UI message stream protocol. Nothing from the ai package is
 * loaded: these are plain schemas and functions.
 */
import { t, type Infer } from "../schema.ts";
import type { Message } from "./providers.ts";

const uiPart = t.object({ type: t.string().min(1).max(100), text: t.string().max(100_000).optional() }).strip();

const uiMessage = t.object({ role: t.enum(["system", "user", "assistant"]), parts: t.array(uiPart).max(100) }).strip();

/**
 * The request body useChat sends ({ id, messages, trigger, messageId, ... }). Only the messages are kept; each
 * keeps its role and its parts' type and text (other fields, such as ids, metadata and part state, are dropped).
 * Limits: 1 to 500 messages, 100 parts per message, 100,000 characters per text part.
 */
export const uiChatBody = t.object({ messages: t.array(uiMessage).min(1).max(500) }).strip();

/** A UI message as uiChatBody keeps it. */
export type UIChatMessage = Infer<typeof uiMessage>;

/**
 * Model messages from AI SDK UI messages: the text parts of each message joined in order. Other parts (files,
 * reasoning, tool calls, data parts, step markers) are left out, and messages without text are dropped.
 */
export function fromUIMessages(messages: readonly { role: "system" | "user" | "assistant"; parts: readonly { type: string; text?: string }[] }[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const content = m.parts.map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
    if (content) out.push({ role: m.role, content });
  }
  return out;
}
