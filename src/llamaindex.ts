/**
 * LlamaIndex.TS: Inferlo's AI aliases as a LlamaIndex LLM and embedding model, and Inferlo tools (function tools and
 * routes) as LlamaIndex tools.
 *
 *   import { toLlamaIndexLLM, toLlamaIndexEmbedding, toLlamaIndexTools } from "@browserlessapi/inferlo/llamaindex";
 *
 *   Settings.llm = toLlamaIndexLLM(app.ai, { model: "fast" });
 *   Settings.embedModel = toLlamaIndexEmbedding(app.ai, { model: "embed" });
 *   const agent = new LLMAgent({ llm: toLlamaIndexLLM(ctx.ai, { for: user.id }), tools: toLlamaIndexTools([getWeather], { ai: ctx.ai }) });
 *
 * The models keep Inferlo's aliases, fallback, budgets, usage tracking and tracing; LlamaIndex runs the agents,
 * indexes, retrievers and query engines. Needs @llamaindex/core 0.6 or later (an optional peer dependency).
 */
import { BaseEmbedding } from "@llamaindex/core/embeddings";
import {
  ToolCallLLM,
  type BaseTool,
  type BaseToolWithCall,
  type ChatMessage,
  type ChatResponse,
  type ChatResponseChunk,
  type CompletionResponse,
  type LLMChatParamsNonStreaming,
  type LLMChatParamsStreaming,
  type LLMCompletionParamsNonStreaming,
  type LLMCompletionParamsStreaming,
  type LLMMetadata,
  type MessageContent,
  type ToolCallLLMMessageOptions,
} from "@llamaindex/core/llms";
import { callModel, routeToolsOf, type AI, type Usage } from "./ai/index.ts";
import type { Image, ImageMediaType, Message, ToolCall, ToolSpec } from "./ai/providers.ts";
import { functionToolSpec, isTool, runFunctionTool, type ToolDef } from "./ai/tool.ts";
import { InferloError } from "./errors.ts";
import type { RouteDef } from "./route.ts";

export interface LlamaIndexLLMOptions {
  /** Alias ("fast") or "provider:model". Default: the AI's default model. */
  model?: string;
  /** Who the calls are for (user or tenant id), for usage tracking and budgets. */
  for?: string;
  temperature?: number;
  maxTokens?: number;
  /** The context window LlamaIndex plans prompts for (its chat memory and response synthesizers). Default 128000. */
  contextWindow?: number;
}

export interface LlamaIndexEmbeddingOptions {
  /** Embedding alias ("embed") or "provider:model". Default: the AI's default embedding model. */
  model?: string;
  /** Who the calls are for (user or tenant id), for usage tracking and budgets. */
  for?: string;
  /** How many texts go in one embedding call. Default 10, LlamaIndex's default. */
  batchSize?: number;
}

const invalid = (message: string, fix: string) => new InferloError("IL5037", message, { fix });
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function checkAI(ai: unknown, name: string): asserts ai is AI {
  if (!ai || typeof ai !== "object" || typeof (ai as AI).generate !== "function") {
    throw invalid(`${name}(ai) needs Inferlo's AI client.`, `Pass ctx.ai in a route handler or job, app.ai, or the client createAI() returns: ${name}(ctx.ai, { model: "fast" }).`);
  }
}

function checkOptions(options: unknown, name: string, known: string[]): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw invalid(`${name}() options must be an object.`, `Use ${name}(ai, { model: "fast" }).`);
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) throw invalid(`Unknown ${name}() option "${key}".`, `Options: ${known.join(", ")}.`);
  }
}

/** Inferlo's AI client as a LlamaIndex LLM with tool calling. Make one with toLlamaIndexLLM(ai, { model }). */
export class InferloLLM extends ToolCallLLM {
  readonly ai: AI;
  readonly options: LlamaIndexLLMOptions;
  supportToolCall = true;

  constructor(ai: AI, options: LlamaIndexLLMOptions = {}) {
    super();
    this.ai = ai;
    this.options = options;
  }

  get metadata(): LLMMetadata {
    return {
      model: this.options.model ?? "default",
      temperature: this.options.temperature ?? 1,
      topP: 1,
      maxTokens: this.options.maxTokens,
      contextWindow: this.options.contextWindow ?? 128_000,
      tokenizer: undefined,
      structuredOutput: false,
    };
  }

  chat(params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions>): Promise<AsyncIterable<ChatResponseChunk<ToolCallLLMMessageOptions>>>;
  chat(params: LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions>): Promise<ChatResponse<ToolCallLLMMessageOptions>>;
  async chat(
    params: LLMChatParamsStreaming<object, ToolCallLLMMessageOptions> | LLMChatParamsNonStreaming<object, ToolCallLLMMessageOptions>,
  ): Promise<ChatResponse<ToolCallLLMMessageOptions> | AsyncIterable<ChatResponseChunk<ToolCallLLMMessageOptions>>> {
    if (!params || !Array.isArray(params.messages)) throw invalid("The Inferlo LLM's chat() needs { messages }.", 'Call llm.chat({ messages: [{ role: "user", content: "Hi" }] }).');
    if (params.responseFormat !== undefined) {
      throw invalid("The Inferlo LLM does not take responseFormat.", "For structured output, call ai.generate({ model, prompt, output: schema }) from Inferlo directly, or ask for JSON in the prompt.");
    }
    const messages = toMessages(params.messages);
    const tools = toolSpecs(params.tools);
    if (!params.stream) return this.respond(messages, tools);
    if (tools?.length) {
      // With tools, the answer and its tool calls arrive as one chunk.
      const answer = await this.respond(messages, tools);
      return (async function* () {
        yield { raw: answer.raw, delta: String(answer.message.content), options: answer.message.options };
      })();
    }
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const stream = this.ai.stream({
      model: this.options.model,
      ...(system ? { system } : {}),
      messages: messages.filter((m) => m.role !== "system"),
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      for: this.options.for,
    });
    return (async function* () {
      for await (const text of stream) yield { raw: null, delta: text };
      const usage = await stream.usage();
      yield { raw: { usage: usageOf(usage) }, delta: "" };
    })();
  }

  complete(params: LLMCompletionParamsStreaming): Promise<AsyncIterable<CompletionResponse>>;
  complete(params: LLMCompletionParamsNonStreaming): Promise<CompletionResponse>;
  async complete(params: LLMCompletionParamsStreaming | LLMCompletionParamsNonStreaming): Promise<CompletionResponse | AsyncIterable<CompletionResponse>> {
    if (!params || params.prompt === undefined) throw invalid("The Inferlo LLM's complete() needs { prompt }.", 'Call llm.complete({ prompt: "Hi" }).');
    if (params.responseFormat !== undefined) {
      throw invalid("The Inferlo LLM does not take responseFormat.", "For structured output, call ai.generate({ model, prompt, output: schema }) from Inferlo directly, or ask for JSON in the prompt.");
    }
    const messages: ChatMessage[] = [{ role: "user", content: params.prompt }];
    if (params.stream) {
      const chunks = await this.chat({ messages, stream: true });
      return (async function* () {
        for await (const chunk of chunks) yield { raw: chunk.raw, text: chunk.delta };
      })();
    }
    const answer = await this.chat({ messages });
    return { raw: answer.raw, text: String(answer.message.content) };
  }

  private async respond(messages: Message[], tools: ToolSpec[] | undefined): Promise<ChatResponse<ToolCallLLMMessageOptions>> {
    const result = await callModel(this.ai, {
      model: this.options.model,
      messages,
      tools,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      for: this.options.for,
    });
    return {
      raw: { usage: usageOf(result.usage) },
      message: {
        role: "assistant",
        content: result.text,
        options: result.toolCalls.length ? { toolCall: result.toolCalls.map((call) => ({ id: call.id, name: call.name, input: toolInput(call.input) })) } : {},
      },
    };
  }
}

/** Inferlo's AI client as a LlamaIndex embedding model. Make one with toLlamaIndexEmbedding(ai, { model }). */
export class InferloEmbedding extends BaseEmbedding {
  readonly ai: AI;
  readonly options: LlamaIndexEmbeddingOptions;

  constructor(ai: AI, options: LlamaIndexEmbeddingOptions = {}) {
    super();
    this.ai = ai;
    this.options = options;
    if (options.batchSize !== undefined) this.embedBatchSize = options.batchSize;
    // One embedding call per batch, instead of one call per text.
    this.getTextEmbeddings = (texts: string[]) => this.embed(texts);
  }

  async getTextEmbedding(text: string): Promise<number[]> {
    const [embedding] = await this.embed([text]);
    return embedding!;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const { embeddings } = await this.ai.embed({ model: this.options.model, input: texts, for: this.options.for });
    return embeddings;
  }
}

/**
 * A LlamaIndex LLM that calls Inferlo's AI: toLlamaIndexLLM(ctx.ai, { model: "fast", for: user.id }). Use it
 * anywhere LlamaIndex takes an LLM (Settings.llm, agents, query and chat engines).
 */
export function toLlamaIndexLLM(ai: AI, options: LlamaIndexLLMOptions = {}): InferloLLM {
  checkAI(ai, "toLlamaIndexLLM");
  checkOptions(options, "toLlamaIndexLLM", ["model", "for", "temperature", "maxTokens", "contextWindow"]);
  return new InferloLLM(ai, { ...options });
}

/**
 * A LlamaIndex embedding model that calls Inferlo's AI: toLlamaIndexEmbedding(app.ai, { model: "embed" }). Use it
 * as Settings.embedModel or in VectorStoreIndex.
 */
export function toLlamaIndexEmbedding(ai: AI, options: LlamaIndexEmbeddingOptions = {}): InferloEmbedding {
  checkAI(ai, "toLlamaIndexEmbedding");
  checkOptions(options, "toLlamaIndexEmbedding", ["model", "for", "batchSize"]);
  if (options.batchSize !== undefined && (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1)) {
    throw invalid(`toLlamaIndexEmbedding({ batchSize }) must be a whole number above 0, got ${String(options.batchSize)}.`, "Use batchSize: 10.");
  }
  return new InferloEmbedding(ai, { ...options });
}

/**
 * Inferlo tools as LlamaIndex tools. Function tools (tool(name, ...).handle(fn)) work anywhere; routes work with a
 * request's AI client ({ ai: ctx.ai }) and run as the signed-in user, with the route's auth and validation.
 */
export function toLlamaIndexTools(tools: readonly (ToolDef | RouteDef)[], options: { ai?: AI } = {}): BaseToolWithCall[] {
  if (!Array.isArray(tools)) throw invalid("toLlamaIndexTools() needs an array of tools.", "Pass [getWeather, createTicket]: function tools and routes.");
  const routeTools = options?.ai ? routeToolsOf(options.ai) : undefined;
  const names = new Set<string>();
  return tools.map((entry) => {
    let spec: ToolSpec;
    let run: (input: unknown) => Promise<string>;
    if (isTool(entry)) {
      spec = functionToolSpec(entry);
      run = async (input) => (await runFunctionTool(entry, input, undefined)).text;
    } else if (entry && typeof entry === "object" && "path" in entry && "method" in entry) {
      if (!routeTools) {
        throw new InferloError("IL5009", "Routes as LlamaIndex tools need the AI client of a request.", {
          fix: "Call toLlamaIndexTools([createTicket], { ai: ctx.ai }) in a route handler, so each route runs as the signed-in user with its auth and validation, or make a function tool with tool(name, { description, input }).handle(fn).",
        });
      }
      const route = entry as RouteDef;
      spec = routeTools.describe(route);
      run = async (input) => (await routeTools.runner(route, input)).text;
    } else {
      throw invalid("toLlamaIndexTools() takes function tools made with tool(...).handle(fn) and routes.", "Pass [getWeather, createTicket].");
    }
    if (names.has(spec.name)) throw new InferloError("IL5013", `Two tools are named "${spec.name}".`, { fix: "Give each tool a unique name (a route's tool name is its export name, or tool: { name })." });
    names.add(spec.name);
    return { metadata: { name: spec.name, description: spec.description, parameters: spec.inputSchema }, call: (input: unknown) => run(input) } as BaseToolWithCall;
  });
}

function usageOf(usage: Usage) {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens, model: usage.model, requested: usage.requested, cost: usage.cost };
}

function toolInput(input: unknown): Record<string, any> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, any>) : { input };
}

/** LlamaIndex tools offered to the model, as Inferlo tool specs. */
function toolSpecs(tools: readonly BaseTool[] | undefined): ToolSpec[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    const meta = tool?.metadata;
    if (!meta || typeof meta.name !== "string" || !meta.name) throw invalid("A tool given to the Inferlo LLM has no name.", "Give LlamaIndex tools metadata: { name, description, parameters }, for example with tool() or FunctionTool.from().");
    return { name: meta.name, description: meta.description ?? "", inputSchema: (meta.parameters as Record<string, unknown> | undefined) ?? { type: "object", properties: {} } };
  });
}

/** LlamaIndex chat messages as Inferlo messages. */
function toMessages(messages: ChatMessage<ToolCallLLMMessageOptions>[]): Message[] {
  return messages.map((message) => {
    const options = (message.options ?? {}) as { toolCall?: { id: string; name: string; input: unknown }[]; toolResult?: { id: string; result: string; isError?: boolean } };
    const { text, images } = contentOf(message.content);
    if (options.toolResult) {
      return { role: "tool", content: options.toolResult.result ?? text, toolCallId: options.toolResult.id, ...(options.toolResult.isError ? { isError: true } : {}) };
    }
    // Roles differ between @llamaindex/core releases ("developer" is newer), so they are compared as strings.
    const role: string = message.role;
    if (role === "system" || role === "developer" || role === "memory") return { role: "system", content: text };
    if (role === "user") return { role: "user", content: text, ...(images.length ? { images } : {}) };
    if (role === "assistant") {
      const calls: ToolCall[] = (options.toolCall ?? []).map((call) => ({ id: call.id, name: call.name, input: typeof call.input === "string" ? parseInput(call.input) : call.input }));
      return { role: "assistant", content: text, ...(calls.length ? { toolCalls: calls } : {}) };
    }
    throw invalid(`The Inferlo LLM does not take "${role}" messages.`, "Use system, user and assistant messages (tool results are user messages with options.toolResult).");
  });
}

function parseInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return { input };
  }
}

function contentOf(content: MessageContent): { text: string; images: Image[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const images: Image[] = [];
  let text = "";
  // Content parts differ between @llamaindex/core releases (image data parts are newer), so they are read loosely.
  for (const raw of Array.isArray(content) ? content : []) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as { type?: string; text?: string; image_url?: { url?: string }; data?: string; mimeType?: string };
    if (part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part.type === "image_url" && part.image_url?.url) images.push({ url: part.image_url.url });
    else if (part.type === "image" && typeof part.data === "string" && IMAGE_TYPES.has(part.mimeType ?? "")) images.push({ base64: part.data, mediaType: part.mimeType as ImageMediaType });
    else throw invalid(`The Inferlo LLM does not take "${String(part.type)}" content${part.type === "image" ? ` of type ${String(part.mimeType)}` : ""}.`, "Send text and images (PNG, JPEG, GIF and WebP).");
  }
  return { text, images };
}
