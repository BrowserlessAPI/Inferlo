/**
 * AI providers. Each one turns a provider-neutral request into an HTTP call.
 * openaiCompatible() covers OpenAI, DeepSeek, Qwen (DashScope), Groq, Together, OpenRouter,
 * Ollama, vLLM, LM Studio and any other server that speaks the Chat Completions API.
 */
import { InferloError } from "../errors.ts";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images the model should look at with this message (user messages only). */
  images?: Image[];
  /** Tools the model asked to call (assistant messages). */
  toolCalls?: ToolCall[];
  /** Which tool call this message answers (tool messages). */
  toolCallId?: string;
  /** The tool call failed (tool messages). */
  isError?: boolean;
}

/** Image types every vision provider accepts. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * An image for a vision model: a URL the provider downloads ({ url: "https://..." }, data: URLs too),
 * or base64 data with its media type ({ base64, mediaType: "image/png" }).
 */
export type Image = { url: string } | { base64: string; mediaType: ImageMediaType };

/** Base64 data and media type of an image given as base64 or a data: URL, or null for a remote URL. */
export function imageData(image: Image): { base64: string; mediaType: string } | null {
  if ("base64" in image) return { base64: image.base64, mediaType: image.mediaType };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.url);
  return match ? { mediaType: match[1]!, base64: match[2]! } : null;
}

/** The URL to send to Chat Completions servers: the URL itself, or a data: URL for base64. */
function imageUrl(image: Image): string {
  return "base64" in image ? `data:${image.mediaType};base64,${image.base64}` : image.url;
}

/** A model's request to call a tool. */
export interface ToolCall {
  id: string;
  name: string;
  /** Arguments as the model sent them (an object when they were valid JSON). */
  input: unknown;
}

/** A tool offered to the model: its name, what it does, and a JSON Schema of its arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object response (when the provider supports it). */
  json?: boolean;
  /** JSON Schema of the expected object, for providers with native structured output. */
  jsonSchema?: Record<string, unknown>;
  /** Tools the model may call. */
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  text: string;
  usage: ProviderUsage;
  /** Tools the model wants to call before it answers. */
  toolCalls?: ToolCall[];
}

export interface Provider {
  readonly name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(request: ProviderRequest): AsyncIterable<string | { usage: ProviderUsage }>;
  embed?(request: { model: string; input: string[]; signal?: AbortSignal }): Promise<{ embeddings: number[][]; usage: ProviderUsage }>;
}

/** Raised when a provider call fails. retryable errors move on to the next fallback model. */
export class ProviderError extends InferloError {
  readonly retryable: boolean;
  constructor(provider: string, status: number, body: string) {
    const retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
    super("IL5006", `${provider} returned ${status || "a network error"}: ${body.slice(0, 300)}`, {
      status: 502,
      expose: false,
      fix: status === 401 || status === 403 ? `Check the API key for ${provider}.` : retryable ? "Add a fallback model to the alias in createApp({ ai })." : undefined,
    });
    this.retryable = retryable;
  }
}

type FetchLike = typeof fetch;

async function post(provider: string, fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ProviderError(provider, 0, String((error as Error).message ?? error));
  }
  if (!response.ok) throw new ProviderError(provider, response.status, await response.text().catch(() => ""));
  return response;
}

/** Parse a server-sent events stream into data payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let index: number;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

export interface OpenAICompatibleOptions {
  /** Name used in model ids ("openai:gpt-5-mini"). */
  name?: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Send response_format json_schema for structured output (default true for OpenAI, false otherwise). */
  nativeStructuredOutput?: boolean;
  fetch?: FetchLike;
}

export function openaiCompatible(options: OpenAICompatibleOptions): Provider {
  const name = options.name ?? "openai-compatible";
  const base = options.baseURL.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = { ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...options.headers };

  const body = (r: ProviderRequest, stream: boolean) => {
    const out: Record<string, unknown> = { model: r.model, messages: r.messages.map(openaiMessage), stream };
    if (r.tools?.length) out.tools = r.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
    if (r.temperature !== undefined) out.temperature = r.temperature;
    if (r.maxTokens !== undefined) out.max_tokens = r.maxTokens;
    if (r.json) {
      out.response_format =
        options.nativeStructuredOutput && r.jsonSchema
          ? { type: "json_schema", json_schema: { name: "output", schema: r.jsonSchema, strict: false } }
          : { type: "json_object" };
    }
    if (stream) out.stream_options = { include_usage: true };
    return out;
  };

  return {
    name,
    async generate(r) {
      const response = await post(name, fetchImpl, `${base}/chat/completions`, headers, body(r, false), r.signal);
      const data = (await response.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = data.choices?.[0]?.message;
      const toolCalls = (message?.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function?.name ?? "", input: parseArguments(call.function?.arguments) }));
      return {
        text: message?.content ?? "",
        usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    },
    async *stream(r) {
      const response = await post(name, fetchImpl, `${base}/chat/completions`, headers, body(r, true), r.signal);
      for await (const data of sseData(response.body!)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield text;
        if (chunk.usage) yield { usage: { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 } };
      }
    },
    async embed({ model, input, signal }) {
      const response = await post(name, fetchImpl, `${base}/embeddings`, headers, { model, input }, signal);
      const data = (await response.json()) as { data: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number } };
      const embeddings = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return { embeddings, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: 0 } };
    },
  };
}

/** Chat Completions message shape, including tool calls and tool results. */
function openaiMessage(m: Message): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })),
    };
  }
  if (m.images?.length) {
    return {
      role: m.role,
      content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.images.map((image) => ({ type: "image_url", image_url: { url: imageUrl(image) } }))],
    };
  }
  return { role: m.role, content: m.content };
}

/** Tool arguments arrive as a JSON string. Invalid JSON is passed on as the raw string, so the tool reports the problem to the model. */
function parseArguments(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Messages API shape: tool calls are tool_use blocks, and consecutive tool results become one user message. */
function anthropicMessages(messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out.at(-1);
      if (last && last.role === "user" && Array.isArray(last.content) && (last.content as { type: string }[]).every((b) => b.type === "tool_result")) {
        (last.content as unknown[]).push(block);
      } else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input ?? {} }))],
      });
      continue;
    }
    if (m.images?.length) {
      // Images first, then the text: Anthropic recommends this order.
      const images = m.images.map((image) => {
        const data = imageData(image);
        return { type: "image", source: data ? { type: "base64", media_type: data.mediaType, data: data.base64 } : { type: "url", url: (image as { url: string }).url } };
      });
      out.push({ role: m.role, content: [...images, ...(m.content ? [{ type: "text", text: m.content }] : [])] });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function openai(options: { apiKey: string; baseURL?: string; organization?: string; fetch?: FetchLike }): Provider {
  return openaiCompatible({
    name: "openai",
    baseURL: options.baseURL ?? "https://api.openai.com/v1",
    apiKey: options.apiKey,
    headers: options.organization ? { "openai-organization": options.organization } : undefined,
    nativeStructuredOutput: true,
    fetch: options.fetch,
  });
}

/** Local models through Ollama's OpenAI-compatible endpoint. */
export function ollama(options: { baseURL?: string; fetch?: FetchLike } = {}): Provider {
  return openaiCompatible({ name: "ollama", baseURL: options.baseURL ?? "http://127.0.0.1:11434/v1", fetch: options.fetch });
}

export function anthropic(options: { apiKey: string; baseURL?: string; version?: string; fetch?: FetchLike }): Provider {
  const name = "anthropic";
  const base = (options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const headers = { "x-api-key": options.apiKey, "anthropic-version": options.version ?? "2023-06-01" };

  const body = (r: ProviderRequest, stream: boolean) => {
    const system = r.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const out: Record<string, unknown> = {
      model: r.model,
      max_tokens: r.maxTokens ?? 4096,
      messages: anthropicMessages(r.messages),
      stream,
    };
    if (system) out.system = system;
    if (r.tools?.length) out.tools = r.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
    if (r.temperature !== undefined) out.temperature = r.temperature;
    return out;
  };

  return {
    name,
    async generate(r) {
      const response = await post(name, fetchImpl, `${base}/v1/messages`, headers, body(r, false), r.signal);
      const data = (await response.json()) as {
        content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const toolCalls = (data.content ?? []).filter((c) => c.type === "tool_use").map((c) => ({ id: c.id ?? "", name: c.name ?? "", input: c.input ?? {} }));
      return { text, usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 }, ...(toolCalls.length ? { toolCalls } : {}) };
    },
    async *stream(r) {
      const response = await post(name, fetchImpl, `${base}/v1/messages`, headers, body(r, true), r.signal);
      const usage = { inputTokens: 0, outputTokens: 0 };
      for await (const data of sseData(response.body!)) {
        const event = JSON.parse(data) as {
          type: string;
          delta?: { type?: string; text?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
        };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) yield event.delta.text;
        if (event.type === "message_start") usage.inputTokens = event.message?.usage?.input_tokens ?? 0;
        if (event.type === "message_delta") usage.outputTokens = event.usage?.output_tokens ?? 0;
      }
      yield { usage };
    },
  };
}

/** Gemini through Google's OpenAI-compatible endpoint. */
export function gemini(options: { apiKey: string; fetch?: FetchLike }): Provider {
  return openaiCompatible({ name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: options.apiKey, fetch: options.fetch });
}

/** What a mockProvider returns: text, or tool calls (with optional text). */
export type MockReply = string | { text?: string; toolCalls?: { id?: string; name: string; input?: unknown }[] };

/**
 * Deterministic provider for tests. respond receives the request and returns the text,
 * or { toolCalls } to call tools (see request.tools and the "tool" messages for results).
 *
 *   mockProvider({ respond: () => JSON.stringify({ priority: "urgent", summary: "Server down" }) })
 *   mockProvider({ respond: (r) => (r.messages.at(-1)!.role === "tool" ? "Done" : { toolCalls: [{ name: "createTicket", input: { title: "Hi" } }] }) })
 */
export function mockProvider(options: {
  name?: string;
  respond: (request: ProviderRequest) => MockReply | Promise<MockReply>;
}): Provider & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  const tokens = (s: string) => Math.ceil(s.length / 4);
  return {
    name: options.name ?? "mock",
    calls,
    async generate(r) {
      calls.push(r);
      const reply = await options.respond(r);
      const text = typeof reply === "string" ? reply : (reply.text ?? "");
      const toolCalls = typeof reply === "string" ? [] : (reply.toolCalls ?? []).map((call, i) => ({ id: call.id ?? `call_${calls.length}_${i + 1}`, name: call.name, input: call.input ?? {} }));
      const usage = { inputTokens: tokens(r.messages.map((m) => m.content).join("")), outputTokens: tokens(text + (toolCalls.length ? JSON.stringify(toolCalls) : "")) };
      return { text, usage, ...(toolCalls.length ? { toolCalls } : {}) };
    },
    async *stream(r) {
      const { text, usage } = await this.generate(r);
      for (const part of text.match(/.{1,8}/gs) ?? []) yield part;
      yield { usage };
    },
    async embed({ input }) {
      const embeddings = input.map((s) => {
        const v = new Array<number>(8).fill(0);
        for (let i = 0; i < s.length; i++) v[i % 8]! += s.charCodeAt(i) / 1000;
        return v;
      });
      return { embeddings, usage: { inputTokens: tokens(input.join("")), outputTokens: 0 } };
    },
  };
}
