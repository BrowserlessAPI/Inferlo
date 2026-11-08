/**
 * Mastra: Inferlo's AI aliases as a Mastra model, and Inferlo tools (function tools and routes) as Mastra tools.
 *
 *   import { Agent } from "@mastra/core/agent";
 *   import { toMastraModel, toMastraTools } from "@browserlessapi/inferlo/mastra";
 *
 *   const agent = new Agent({
 *     id: "support",
 *     name: "Support",
 *     instructions: "Answer support questions.",
 *     model: toMastraModel(ctx.ai, { model: "fast", for: user.id }),
 *     tools: toMastraTools([getWeather, createTicket], { ai: ctx.ai }),
 *   });
 *   const result = await agent.generate(body.question);
 *
 * The model is an AI SDK language model (specification v2, which every Mastra 1.x release accepts) whose calls go
 * through Inferlo's AI client, so the agent keeps Inferlo's aliases, fallback across providers, budgets, usage
 * tracking and tracing; Mastra runs the agent loop, tools, memory and workflows.
 * Needs @mastra/core 1.0 or later (an optional peer dependency).
 */
import { createTool } from "@mastra/core/tools";
import type { AI } from "./ai/index.ts";
import {
  InferloAISdkModel,
  aiSdkPromptToMessages,
  aiSdkSchema,
  checkModelArgs,
  inferloToolRunners,
  type AISdkCallOptions,
  type AISdkCallWarning,
  type AISdkContent,
  type AISdkGenerateResult,
  type AISdkModelOptions,
  type AISdkStreamPart,
} from "./ai/ai-sdk-model.ts";
import type { Message } from "./ai/providers.ts";
import type { ToolDef } from "./ai/tool.ts";
import type { RouteDef } from "./route.ts";

export type MastraModelOptions = AISdkModelOptions;
/** A warning in the AI SDK's format, for settings Inferlo does not pass on. */
export type MastraCallWarning = AISdkCallWarning;
/** The AI SDK's call options (LanguageModelV2CallOptions) as far as Inferlo uses them. */
export type MastraCallOptions = AISdkCallOptions;
/** One part of a generated answer: text or a tool call (input is the arguments as JSON text). */
export type MastraContent = AISdkContent;
export type MastraGenerateResult = AISdkGenerateResult;
/** The parts doStream() sends: the answer's text, its tool calls and the finish part with usage. */
export type MastraStreamPart = AISdkStreamPart;

const MASTRA = { code: "IL5034", tools: "Use function tools (createTool() from @mastra/core/tools, or toMastraTools())" };

/** The AI SDK's prompt, as Mastra sends it, as Inferlo messages. */
export function mastraPromptToMessages(prompt: readonly Record<string, any>[]): Message[] {
  return aiSdkPromptToMessages(prompt, MASTRA.code);
}

/** Inferlo's AI client as an AI SDK language model for Mastra. Make one with toMastraModel(ai, { model }). */
export class InferloMastraModel extends InferloAISdkModel {
  constructor(ai: AI, options: MastraModelOptions = {}) {
    super(ai, options, MASTRA);
  }
}

/**
 * A Mastra model that calls Inferlo's AI: toMastraModel(ctx.ai, { model: "fast", for: user.id }). Pass it as an
 * Agent's model (new Agent({ model })); the agent then gets Inferlo's aliases, fallback, budgets and usage.
 */
export function toMastraModel(ai: AI, options: MastraModelOptions = {}): InferloMastraModel {
  checkModelArgs(ai, options, "toMastraModel", MASTRA.code, "Set temperature and maxOutputTokens with the Agent's modelSettings.");
  return new InferloMastraModel(ai, { ...options });
}

/**
 * Inferlo tools as Mastra tools, keyed by name for an Agent's tools. Function tools (tool(name, ...).handle(fn))
 * work anywhere; routes work with a request's AI client ({ ai: ctx.ai }) and run as the signed-in user, with the
 * route's auth and validation.
 */
export function toMastraTools(tools: readonly (ToolDef | RouteDef)[], options: { ai?: AI } = {}): Record<string, ReturnType<typeof createTool>> {
  const out: Record<string, ReturnType<typeof createTool>> = {};
  for (const { spec, run } of inferloToolRunners(tools, options.ai, "toMastraTools", MASTRA.code)) {
    out[spec.name] = createTool({
      id: spec.name,
      description: spec.description,
      inputSchema: aiSdkSchema(spec.inputSchema) as never,
      execute: async (input: unknown, context?: { abortSignal?: AbortSignal }) => run(typeof input === "string" ? JSON.parse(input || "{}") : (input ?? {}), context?.abortSignal),
    } as never);
  }
  return out;
}
