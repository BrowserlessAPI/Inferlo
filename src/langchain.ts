/**
 * LangChain.js: Inferlo's AI aliases as a LangChain chat model, and Inferlo tools (function tools and routes)
 * as LangChain tools.
 *
 *   import { toLangChainModel, toLangChainTools } from "@browserlessapi/inferlo/langchain";
 *
 *   const model = toLangChainModel(ctx.ai, { model: "fast", for: user.id });
 *   const agent = createAgent({ model, tools: toLangChainTools([getWeather, createTicket], { ai: ctx.ai }) });
 *
 * The model keeps Inferlo's aliases, fallback, budgets, usage tracking and tracing; LangChain runs the agent
 * loop and the tools. Needs @langchain/core 0.3 or later (an optional peer dependency).
 */
import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { callModel, routeToolsOf, type AI } from "./ai/index.ts";
import type { Image, Message, ToolSpec } from "./ai/providers.ts";
import { functionToolSpec, isTool, runFunctionTool, type ToolDef } from "./ai/tool.ts";
import { InferloError } from "./errors.ts";
import type { RouteDef } from "./route.ts";

export interface LangChainModelOptions {
  /** Alias ("fast") or "provider:model". Default: the AI's default model. */
  model?: string;
  /** Who the calls are for (user or tenant id), for usage tracking and budgets. */
  for?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Call options of the chat model: LangChain's, plus the tools bindTools() adds. */
export interface InferloChatModelCallOptions extends BaseChatModelCallOptions {
  tools?: BindToolsInput[];
}

const invalid = (message: string, fix: string) => new InferloError("IL5030", message, { fix });

/** Inferlo's AI client as a LangChain chat model. Make one with toLangChainModel(ai, { model }). */
export class InferloChatModel extends BaseChatModel<InferloChatModelCallOptions, AIMessageChunk> {
  readonly ai: AI;
  readonly options: LangChainModelOptions;

  constructor(ai: AI, options: LangChainModelOptions = {}) {
    super({});
    this.ai = ai;
    this.options = options;
  }

  static lc_name(): string {
    return "InferloChatModel";
  }

  _llmType(): string {
    return "inferlo";
  }

  /** Offer tools to the model: LangChain tools, OpenAI-style tool definitions, or Inferlo function tools. */
  override bindTools(tools: (BindToolsInput | ToolDef)[], kwargs?: Partial<InferloChatModelCallOptions>): any {
    return this.withConfig({ ...kwargs, tools: tools as BindToolsInput[] } as Partial<InferloChatModelCallOptions>);
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    const result = await callModel(this.ai, {
      model: this.options.model,
      messages: toMessages(messages),
      tools: toolSpecs(options.tools),
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      for: this.options.for,
      signal: options.signal,
    });
    const usage = { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens, total_tokens: result.usage.inputTokens + result.usage.outputTokens };
    const message = new AIMessage({
      content: result.text,
      tool_calls: result.toolCalls.map((call) => ({ id: call.id, name: call.name, args: toolArgs(call.input), type: "tool_call" as const })),
      usage_metadata: usage,
      response_metadata: { model: result.usage.model, requested: result.usage.requested, cost: result.usage.cost },
    });
    return { generations: [{ text: result.text, message }], llmOutput: { tokenUsage: { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens, totalTokens: usage.total_tokens } } };
  }

  /** Streams text with ai.stream(). With tools bound, the answer (and its tool calls) comes as one chunk. */
  override async *_streamResponseChunks(messages: BaseMessage[], options: this["ParsedCallOptions"], runManager?: { handleLLMNewToken(token: string): Promise<unknown> }): AsyncGenerator<ChatGenerationChunk> {
    if (toolSpecs(options.tools)?.length) {
      const { generations } = await this._generate(messages, options);
      const message = generations[0]!.message as AIMessage;
      yield new ChatGenerationChunk({
        text: generations[0]!.text,
        message: new AIMessageChunk({
          content: message.content,
          tool_call_chunks: (message.tool_calls ?? []).map((call, index) => ({ id: call.id, name: call.name, args: JSON.stringify(call.args), index, type: "tool_call_chunk" as const })),
          usage_metadata: message.usage_metadata,
          response_metadata: message.response_metadata,
        }),
      });
      return;
    }
    const all = toMessages(messages);
    const system = all.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const stream = this.ai.stream({
      model: this.options.model,
      ...(system ? { system } : {}),
      messages: all.filter((m) => m.role !== "system"),
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      for: this.options.for,
      signal: options.signal,
    });
    for await (const text of stream) {
      yield new ChatGenerationChunk({ text, message: new AIMessageChunk({ content: text }) });
      await runManager?.handleLLMNewToken(text);
    }
    const usage = await stream.usage();
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        usage_metadata: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
        response_metadata: { model: usage.model, requested: usage.requested, cost: usage.cost },
      }),
    });
  }
}

/**
 * A LangChain chat model that calls Inferlo's AI: toLangChainModel(ctx.ai, { model: "fast", for: user.id }).
 * Use it anywhere LangChain takes a chat model (createAgent, chains, LangGraph).
 */
export function toLangChainModel(ai: AI, options: LangChainModelOptions = {}): InferloChatModel {
  if (!ai || typeof ai !== "object" || typeof (ai as AI).generate !== "function") {
    throw invalid("toLangChainModel(ai) needs Inferlo's AI client.", 'Pass ctx.ai in a route handler or job, app.ai, or the client createAI() returns: toLangChainModel(ctx.ai, { model: "fast" }).');
  }
  if (options === null || typeof options !== "object") throw invalid("toLangChainModel() options must be an object.", 'Use toLangChainModel(ai, { model: "fast" }).');
  for (const key of Object.keys(options)) {
    if (!["model", "for", "temperature", "maxTokens"].includes(key)) throw invalid(`Unknown toLangChainModel() option "${key}".`, "Options: model, for, temperature, maxTokens.");
  }
  return new InferloChatModel(ai, { ...options });
}

/**
 * Inferlo tools as LangChain tools. Function tools (tool(name, ...).handle(fn)) work anywhere; routes work with a
 * request's AI client ({ ai: ctx.ai }) and run as the signed-in user, with the route's auth and validation.
 */
export function toLangChainTools(tools: readonly (ToolDef | RouteDef)[], options: { ai?: AI } = {}): DynamicStructuredTool[] {
  if (!Array.isArray(tools)) throw invalid("toLangChainTools() needs an array of tools.", "Pass [getWeather, createTicket]: function tools and routes.");
  const routeTools = options.ai ? routeToolsOf(options.ai) : undefined;
  const names = new Set<string>();
  return tools.map((entry) => {
    let spec: ToolSpec;
    let run: (input: unknown) => Promise<string>;
    if (isTool(entry)) {
      spec = functionToolSpec(entry);
      run = async (input) => (await runFunctionTool(entry, input, undefined)).text;
    } else if (entry && typeof entry === "object" && "path" in entry && "method" in entry) {
      if (!routeTools) {
        throw new InferloError("IL5009", "Routes as LangChain tools need the AI client of a request.", {
          fix: "Call toLangChainTools([createTicket], { ai: ctx.ai }) in a route handler, so each route runs as the signed-in user with its auth and validation, or make a function tool with tool(name, { description, input }).handle(fn).",
        });
      }
      const route = entry as RouteDef;
      spec = routeTools.describe(route);
      run = async (input) => (await routeTools.runner(route, input)).text;
    } else {
      throw invalid("toLangChainTools() takes function tools made with tool(...).handle(fn) and routes.", "Pass [getWeather, createTicket].");
    }
    if (names.has(spec.name)) throw new InferloError("IL5013", `Two tools are named "${spec.name}".`, { fix: "Give each tool a unique name (a route's tool name is its export name, or tool: { name })." });
    names.add(spec.name);
    return new DynamicStructuredTool({ name: spec.name, description: spec.description, schema: spec.inputSchema as never, func: async (input: unknown) => run(input) });
  });
}

/** Bound tools as Inferlo tool specs. */
function toolSpecs(tools: readonly unknown[] | undefined): ToolSpec[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    if (isTool(tool)) return functionToolSpec(tool);
    const converted = convertToOpenAITool(tool as never) as { function?: { name?: string; description?: string; parameters?: Record<string, unknown> } };
    const fn = converted.function;
    if (!fn?.name) throw invalid("A tool bound to the Inferlo chat model has no name.", "Bind LangChain tools, { type: \"function\", function: { name, description, parameters } } objects, or Inferlo function tools.");
    return { name: fn.name, description: fn.description ?? "", inputSchema: fn.parameters ?? { type: "object", properties: {} } };
  });
}

function toolArgs(input: unknown): Record<string, any> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, any>) : { input };
}

function typeOf(message: BaseMessage): string {
  const m = message as unknown as { getType?: () => string; _getType?: () => string; type?: string };
  return typeof m.getType === "function" ? m.getType() : typeof m._getType === "function" ? m._getType() : String(m.type);
}

/** LangChain messages as Inferlo messages. */
function toMessages(messages: BaseMessage[]): Message[] {
  return messages.map((message) => {
    const type = typeOf(message);
    const { text, images } = contentOf(message.content);
    if (type === "system") return { role: "system", content: text };
    if (type === "human" || type === "generic") return { role: "user", content: text, ...(images.length ? { images } : {}) };
    if (type === "ai") {
      const calls = (message as AIMessage).tool_calls ?? [];
      return { role: "assistant", content: text, ...(calls.length ? { toolCalls: calls.map((c) => ({ id: c.id ?? "", name: c.name, input: c.args })) } : {}) };
    }
    if (type === "tool") {
      const tool = message as unknown as { tool_call_id: string; status?: string };
      return { role: "tool", content: text, toolCallId: tool.tool_call_id, ...(tool.status === "error" ? { isError: true } : {}) };
    }
    throw invalid(`The Inferlo chat model does not take "${type}" messages.`, "Use system, human, AI and tool messages.");
  });
}

function contentOf(content: unknown): { text: string; images: Image[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const images: Image[] = [];
  let text = "";
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string; image_url?: string | { url?: string }; url?: string; data?: string; mimeType?: string; mime_type?: string; source_type?: string };
    if (p.type === "text" && typeof p.text === "string") text += p.text;
    else if (p.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (url) images.push({ url });
    } else if (p.type === "image") {
      const mediaType = p.mimeType ?? p.mime_type;
      if (typeof p.url === "string") images.push({ url: p.url });
      else if (typeof p.data === "string" && mediaType) images.push({ base64: p.data, mediaType: mediaType as never });
    }
  }
  return { text, images };
}
