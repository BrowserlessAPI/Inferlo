/**
 * Inferlo's AI module on its own: providers, aliases with fallback, structured output, streaming,
 * embeddings, image input, tool calling with plain functions and usage tracking, without createApp. Use it in any framework or script:
 *
 *   import { createAI, anthropic, t } from "@browserlessapi/inferlo/ai"
 *   const ai = createAI({ providers: { anthropic: anthropic({ apiKey }) }, models: { fast: "anthropic:claude-haiku-4-5" } })
 *   const { object } = await ai.generate({ model: "fast", prompt, output: t.object({ ... }) })
 *
 * This entry point never loads the router, database or jobs code.
 */
export { createAI, cosineSimilarity, extractJson } from "./index.ts";
export { tool, isTool, ToolBuilder } from "./tool.ts";
export { uiChatBody, fromUIMessages } from "./ui.ts";
export type { UIChatMessage } from "./ui.ts";
export type { ToolDef, FunctionToolOptions, ToolContext } from "./tool.ts";
export { openai, openaiCompatible, anthropic, gemini, ollama, mockProvider, ProviderError } from "./providers.ts";
export type { TracingConfig, OtelApi, OtelSpan } from "../tracing.ts";
export type { AI, AIConfig, GenerateOptions, GenerateResult, StreamResult, StreamResponseInit, Usage, Pricing, Step, ToolCallResult } from "./index.ts";
export type { Provider, ProviderRequest, ProviderResponse, ProviderUsage, Image, ImageMediaType, Message, MockReply, ToolCall, ToolSpec, OpenAICompatibleOptions } from "./providers.ts";
export { t, Schema, ObjectSchema, ArraySchema, ValidationError, toJSONSchema } from "../schema.ts";
export type { Infer, InferInput, Issue, JSONSchema, AnySchema } from "../schema.ts";
export { InferloError, httpError } from "../errors.ts";
export { env } from "../env.ts";
