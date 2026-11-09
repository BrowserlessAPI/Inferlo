/**
 * AI providers. Each one turns a provider-neutral request into an HTTP call.
 * openaiCompatible() covers OpenAI, DeepSeek, Qwen (DashScope), Groq, Together, OpenRouter,
 * Ollama, vLLM, LM Studio and any other server that speaks the Chat Completions API.
 */
import { InferloError } from "../errors.ts";
import { holdSecrets } from "../redact.ts";

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

/** One part of a provider stream: a text chunk, the usage of the call, or tool calls the model wants to run. */
export type StreamPart = string | { usage: ProviderUsage } | { toolCalls: ToolCall[] };

export interface Provider {
  readonly name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  /**
   * Streams the answer: text chunks, the usage, and the tool calls the model made (once each call is complete), for
   * ai.stream({ tools }). A provider that never yields { toolCalls } streams text only.
   */
  stream?(request: ProviderRequest): AsyncIterable<StreamPart>;
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
  return chatCompletions(options, {});
}

/** How a Chat Completions server differs from OpenAI's, for the provider adapters built on it. */
interface ChatCompletionsVariant {
  /** Leave out stream_options (servers that reject it and report usage in the last chunk anyway). */
  noStreamOptions?: boolean;
  /** Headers computed before each call, such as a short-lived access token. */
  auth?: () => Promise<Record<string, string>>;
}

function chatCompletions(options: OpenAICompatibleOptions, variant: ChatCompletionsVariant): Provider {
  const name = options.name ?? "openai-compatible";
  const base = options.baseURL.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const fixed: Record<string, string> = { ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...options.headers };
  const headersFor = async (): Promise<Record<string, string>> => (variant.auth ? { ...fixed, ...(await variant.auth()) } : fixed);

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
    if (stream && !variant.noStreamOptions) out.stream_options = { include_usage: true };
    return out;
  };

  return holdSecrets({
    name,
    async generate(r) {
      const response = await post(name, fetchImpl, `${base}/chat/completions`, await headersFor(), body(r, false), r.signal);
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
      const response = await post(name, fetchImpl, `${base}/chat/completions`, await headersFor(), body(r, true), r.signal);
      const calls: { id: string; name: string; args: string }[] = [];
      for await (const data of sseData(response.body!)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as {
          choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) yield delta.content;
        // Tool calls arrive in pieces: the id and name first, then the arguments, keyed by index.
        for (const part of delta?.tool_calls ?? []) {
          const index = part.index ?? 0;
          const call = (calls[index] ??= { id: "", name: "", args: "" });
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
        }
        if (chunk.usage) yield { usage: { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 } };
      }
      const toolCalls = calls.filter(Boolean).map((call) => ({ id: call.id, name: call.name, input: parseArguments(call.args) }));
      if (toolCalls.length) yield { toolCalls };
    },
    async embed({ model, input, signal }) {
      const response = await post(name, fetchImpl, `${base}/embeddings`, await headersFor(), { model, input }, signal);
      const data = (await response.json()) as { data: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number } };
      const embeddings = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return { embeddings, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: 0 } };
    },
  }, [options.apiKey, ...Object.entries(options.headers ?? {}).filter(([k]) => /^(authorization|x-api-key|api-key)$/i.test(k)).map(([, v]) => v)]);
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

/**
 * A JSON Schema Anthropic's structured outputs accept: numeric and length limits (minimum, maximum, minLength,
 * maxLength, minItems, maxItems and their exclusive forms) are moved into the description, and every object gets
 * additionalProperties: false. Inferlo still validates the answer against the full schema.
 */
function anthropicOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(anthropicOutputSchema);
  if (!schema || typeof schema !== "object") return schema;
  const LIMITS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "multipleOf"];
  const out: Record<string, unknown> = {};
  const moved: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (LIMITS.includes(key)) {
      moved.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    out[key] = key === "properties" && value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, anthropicOutputSchema(sub)]))
      : key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf" ? anthropicOutputSchema(value) : value;
  }
  if (moved.length) out.description = [out.description, `(${moved.join(", ")})`].filter(Boolean).join(" ");
  if (out.type === "object" || (Array.isArray(out.type) && out.type.includes("object"))) out.additionalProperties = false;
  return out;
}

export function anthropic(options: {
  apiKey: string;
  baseURL?: string;
  version?: string;
  /** Send output_config.format (Anthropic's structured outputs) for ai.generate({ output }) (default true). */
  nativeStructuredOutput?: boolean;
  fetch?: FetchLike;
}): Provider {
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
    // Structured outputs: the answer's text is JSON that matches the schema.
    if (r.json && r.jsonSchema && options.nativeStructuredOutput !== false) out.output_config = { format: { type: "json_schema", schema: anthropicOutputSchema(r.jsonSchema) } };
    return out;
  };

  return holdSecrets({
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
      // tool_use blocks start with the id and name; their input arrives as pieces of JSON.
      const calls = new Map<number, { id: string; name: string; json: string }>();
      for await (const data of sseData(response.body!)) {
        const event = JSON.parse(data) as {
          type: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
        };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) yield event.delta.text;
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          calls.set(event.index ?? calls.size, { id: event.content_block.id ?? "", name: event.content_block.name ?? "", json: "" });
        }
        if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          const call = calls.get(event.index ?? -1);
          if (call) call.json += event.delta.partial_json ?? "";
        }
        if (event.type === "message_start") usage.inputTokens = event.message?.usage?.input_tokens ?? 0;
        if (event.type === "message_delta") usage.outputTokens = event.usage?.output_tokens ?? 0;
      }
      yield { usage };
      if (calls.size) yield { toolCalls: [...calls.values()].map((call) => ({ id: call.id, name: call.name, input: parseArguments(call.json) })) };
    },
  }, [options.apiKey]);
}

/** Gemini through Google's OpenAI-compatible endpoint. */
export function gemini(options: {
  apiKey: string;
  /** Send response_format json_schema (Gemini's structured output) for ai.generate({ output }) (default true). */
  nativeStructuredOutput?: boolean;
  fetch?: FetchLike;
}): Provider {
  return openaiCompatible({
    name: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: options.apiKey,
    nativeStructuredOutput: options.nativeStructuredOutput ?? true,
    fetch: options.fetch,
  });
}

/** Mistral's models (La Plateforme) through its Chat Completions API: chat, tools, vision, structured output and embeddings. */
export function mistral(options: {
  apiKey: string;
  /** Another endpoint with the same API, such as a self-deployed Mistral model (default https://api.mistral.ai/v1). */
  baseURL?: string;
  /** Send response_format json_schema (Mistral's structured output) for ai.generate({ output }) (default true). */
  nativeStructuredOutput?: boolean;
  fetch?: FetchLike;
}): Provider {
  checkProviderOptions("mistral", { apiKey: options.apiKey }, ["apiKey"]);
  return chatCompletions(
    {
      name: "mistral",
      baseURL: options.baseURL ?? "https://api.mistral.ai/v1",
      apiKey: options.apiKey,
      nativeStructuredOutput: options.nativeStructuredOutput ?? true,
      fetch: options.fetch,
    },
    // Mistral reports the usage in the last chunk without stream_options, which its API does not list.
    { noStreamOptions: true },
  );
}

/** Returns an access token; called before each request (the function should cache tokens until they expire). */
export type AccessToken = () => string | Promise<string>;

/**
 * Azure OpenAI (Azure AI Foundry) through its v1 API: model ids are deployment names ("azure:my-gpt-5-mini").
 * Authenticate with the resource's API key, or with Microsoft Entra ID: token returns a bearer token for the scope
 * https://ai.azure.com/.default, for example getBearerTokenProvider(new DefaultAzureCredential(), "https://ai.azure.com/.default")
 * from @azure/identity (managed identities, workload identity and az login, without keys).
 */
export function azureOpenAI(options: {
  /** The resource name: https://<resource>.openai.azure.com/openai/v1. */
  resource?: string;
  /** The full v1 endpoint instead of resource, such as https://<name>.services.ai.azure.com/openai/v1. */
  baseURL?: string;
  apiKey?: string;
  token?: AccessToken;
  /** Send response_format json_schema (structured outputs) for ai.generate({ output }) (default true). */
  nativeStructuredOutput?: boolean;
  fetch?: FetchLike;
}): Provider {
  if ((options.resource === undefined) === (options.baseURL === undefined)) {
    throw invalidProvider("azureOpenAI", "needs either resource (the Azure OpenAI resource name) or baseURL, not both.");
  }
  if (options.resource !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(options.resource)) {
    throw invalidProvider("azureOpenAI", `resource must be the resource name (letters, digits and dashes), got ${JSON.stringify(options.resource)}.`);
  }
  if (options.baseURL !== undefined && !/^https?:\/\/[^/]/.test(options.baseURL)) throw invalidProvider("azureOpenAI", `baseURL must be an http(s) URL, got ${JSON.stringify(options.baseURL)}.`);
  if ((options.apiKey === undefined) === (options.token === undefined)) {
    throw invalidProvider("azureOpenAI", "needs either apiKey or token (Microsoft Entra ID), not both.");
  }
  if (options.apiKey !== undefined) checkProviderOptions("azureOpenAI", { apiKey: options.apiKey }, ["apiKey"]);
  if (options.token !== undefined && typeof options.token !== "function") throw invalidProvider("azureOpenAI", "token must be a function that returns an access token.");
  return chatCompletions(
    {
      name: "azure",
      baseURL: options.baseURL ?? `https://${options.resource}.openai.azure.com/openai/v1`,
      headers: options.apiKey !== undefined ? { "api-key": options.apiKey } : undefined,
      nativeStructuredOutput: options.nativeStructuredOutput ?? true,
      fetch: options.fetch,
    },
    { auth: options.token ? bearer("azure", options.token) : undefined },
  );
}

/**
 * Google Vertex AI through its OpenAI-compatible endpoint: Gemini and the partner and open models Vertex AI serves
 * there, with model ids such as "vertex:google/gemini-2.5-flash". token returns an OAuth access token for the scope
 * https://www.googleapis.com/auth/cloud-platform, for example from google-auth-library's GoogleAuth (service
 * accounts, workload identity and gcloud application-default credentials).
 */
export function vertexAI(options: {
  /** The Google Cloud project id. */
  project: string;
  /** "global" (default) or a region such as "europe-west4", which keeps requests in that region. */
  location?: string;
  token: AccessToken;
  /** Send response_format json_schema (structured output) for ai.generate({ output }) (default true). */
  nativeStructuredOutput?: boolean;
  fetch?: FetchLike;
}): Provider {
  checkProviderOptions("vertexAI", { project: options.project }, ["project"]);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)) {
    throw invalidProvider("vertexAI", `project must be a Google Cloud project id (6 to 30 lowercase letters, digits and dashes), got ${JSON.stringify(options.project)}.`);
  }
  const location = options.location ?? "global";
  if (typeof location !== "string" || !/^[a-z]+(-[a-z]+[0-9]+)?$/.test(location)) {
    throw invalidProvider("vertexAI", `location must be "global" or a region such as "us-central1", got ${JSON.stringify(location)}.`);
  }
  if (typeof options.token !== "function") throw invalidProvider("vertexAI", "needs token, a function that returns an OAuth access token.");
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return chatCompletions(
    {
      name: "vertex",
      baseURL: `https://${host}/v1/projects/${options.project}/locations/${location}/endpoints/openapi`,
      nativeStructuredOutput: options.nativeStructuredOutput ?? true,
      fetch: options.fetch,
    },
    { auth: bearer("vertex", options.token) },
  );
}

/** Authorization header from a token function; a failing or empty token is a provider error that is not retried. */
function bearer(provider: string, token: AccessToken): () => Promise<Record<string, string>> {
  return async () => {
    let value: unknown;
    try {
      value = await token();
    } catch (error) {
      throw new ProviderError(provider, 401, `the token function failed: ${String((error as Error)?.message ?? error)}`);
    }
    if (typeof value !== "string" || !value) throw new ProviderError(provider, 401, "the token function returned no token");
    return { authorization: `Bearer ${value}` };
  };
}

function invalidProvider(factory: string, problem: string): InferloError {
  return new InferloError("IL5041", `${factory}() ${problem}`, { fix: "See the provider's options in docs/ai.md (\"Providers\")." });
}

function checkProviderOptions(factory: string, values: Record<string, unknown>, required: string[]): void {
  for (const key of required) {
    const value = values[key];
    if (typeof value !== "string" || !value.trim()) throw invalidProvider(factory, `needs ${key} (a non-empty string), got ${value === undefined ? "nothing" : typeof value === "string" ? "an empty string" : typeof value}.`);
  }
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
      const { text, usage, toolCalls } = await this.generate(r);
      for (const part of text.match(/.{1,8}/gs) ?? []) yield part;
      yield { usage };
      if (toolCalls?.length) yield { toolCalls };
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
