/**
 * Inferlo AI: one API for every model provider, with model aliases, automatic fallback,
 * typed structured output, streaming, embeddings, usage tracking and budgets.
 *
 *   ai: {
 *     providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
 *     models: { fast: ["anthropic:claude-haiku-4-5", "openai:gpt-5-mini"] },
 *   }
 *
 *   const { object } = await ctx.ai.generate({ model: "fast", prompt, output: Triage })
 */
import { InferloError, didYouMean } from "../errors.ts";
import type { AnySchema } from "../schema.ts";
import type { RouteDef } from "../route.ts";
import { functionToolSpec, isTool, runFunctionTool, type ToolDef } from "./tool.ts";
import { type InferOutput, invalidOutputSchema, schemaAdapter, type StandardSchema } from "./standard-schema.ts";
import { createRedactor, secretsOf } from "../redact.ts";
import type { Cache } from "../cache.ts";
import { checkTracing, clientTracing, type OtelSpan, type TracingConfig } from "../tracing.ts";
import { ProviderError, imageData, type Image, type Message, type Provider, type ProviderUsage, type ToolCall, type ToolSpec } from "./providers.ts";

export * from "./providers.ts";
export { tool, isTool, ToolBuilder } from "./tool.ts";
export type { ToolDef, FunctionToolOptions, ToolContext } from "./tool.ts";
export { uiChatBody, fromUIMessages, type UIChatMessage } from "./ui.ts";

export interface Pricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export interface Usage {
  /** Alias or model id you asked for. */
  requested: string;
  /** "provider:model" that actually answered. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD, when pricing is configured for the model. Otherwise 0. */
  cost: number;
  /** Who to bill: the userId / tenant you passed as `for`. */
  for?: string;
  kind: "generate" | "stream" | "embed";
  durationMs: number;
  /** The prompt file that made the call ("summarize-ticket@2"), when the options came from prompt.render(). */
  prompt?: string;
  /** True when the answer came from the cache (ai.generate({ cache })): no model was called, tokens and cost are 0. */
  cached?: boolean;
}

export interface AIConfig {
  /** Named providers: { anthropic: anthropic({...}), local: ollama() }. */
  providers: Record<string, Provider>;
  /** Aliases to "provider:model" ids. A list means fallback order. */
  models?: Record<string, string | string[]>;
  /** Alias or id used when a call does not name a model. */
  defaultModel?: string;
  /** Prices per model id ("anthropic:claude-haiku-4-5") for cost tracking. Inferlo ships no prices because they change. */
  pricing?: Record<string, Pricing>;
  /**
   * Where ai.generate({ cache }) keeps answers. createApp sets the app's cache (memory, database or Redis);
   * createAI without it keeps up to 1000 answers in memory.
   */
  cache?: AICache;
  /** Called after every call. Store it, bill it, log it. */
  onUsage?: (usage: Usage) => void | Promise<void>;
  /**
   * Called before a call that has `for` set. Return false (or throw) to block it,
   * e.g. when a user has used up their credits. Blocked calls raise IL5004 (HTTP 402).
   */
  allow?: (info: { for: string; model: string }) => boolean | Promise<boolean>;
  /**
   * OpenTelemetry spans for AI calls: import * as otel from "@opentelemetry/api", then tracing: { api: otel }.
   * Every generate, stream and embed call gets a client span ("chat claude-haiku-4-5") with the provider, the model
   * that answered, tokens and cost. Prompts and answers are never recorded. In an app, createApp({ tracing }) sets it.
   */
  tracing?: TracingConfig;
}

export interface GenerateOptions<O extends AnySchema | StandardSchema | undefined> {
  /** Alias ("fast") or "provider:model". */
  model?: string;
  /** Shorthand for a single user message. */
  prompt?: string;
  /** Images for the prompt message: [{ url: "https://..." }] or [{ base64, mediaType: "image/png" }]. Needs a vision model. */
  images?: Image[];
  system?: string;
  messages?: Message[];
  /**
   * Schema for structured output. The result's `object` is validated and typed. A t.* schema, or a Standard Schema
   * with JSON Schema support from another library: z.object() (Zod 4.2+), type() (ArkType 2.1.28+) or Valibot's
   * toStandardJsonSchema(v.object()).
   */
  output?: O;
  temperature?: number;
  maxTokens?: number;
  /** Who this call is for (user or tenant id), for usage tracking and budgets. */
  for?: string;
  signal?: AbortSignal;
  /** Extra attempts when structured output does not match the schema (default 1). */
  repairAttempts?: number;
  /**
   * Tools the model may call: functions made with tool(name, { description, input }).handle(fn), which work
   * anywhere, and routes, which run with the current user's permissions and only work through ctx.ai
   * inside a route handler: ctx.ai.generate({ prompt, tools: [getWeather, createTicket] }).
   */
  tools?: readonly (ToolDef | RouteDef)[];
  /** Most model calls when tools are given: tool rounds plus the final answer (default 5). More raises IL5010. */
  maxSteps?: number;
  /** "name@version" of the prompt the text came from, recorded in usage and traces. Set by prompt.render(). */
  promptId?: string;
  /**
   * Reuse the answer of an identical earlier call for ttlMs (opt in): same model or alias, messages, images, output
   * schema, temperature and maxTokens. Kept in the app's cache (createApp({ cache })), invalidated by tags. Not with tools.
   */
  cache?: { ttlMs: number; tags?: readonly string[] };
}

/** One tool call the model made, with what the route returned. */
export interface ToolCallResult {
  id: string;
  /** Tool name: the tool's name, or the route's export name (createTicket). */
  name: string;
  input: unknown;
  /** HTTP status the route answered with (a function tool: 200, 422 for invalid input, or the status of the httpError it threw). */
  status: number;
  /** Parsed JSON response (or text), exactly what the model saw. */
  output: unknown;
  /** True when the tool failed (status 400 or more). */
  isError: boolean;
}

/** One model call. */
export interface Step {
  text: string;
  /** Tools the model called in this step (empty for the final answer). */
  toolCalls: ToolCallResult[];
  usage: ProviderUsage;
}

export interface GenerateResult<O> {
  text: string;
  object: O;
  /** True when the answer came from the cache (ai.generate({ cache })). */
  cached?: boolean;
  /** Totals over every step. */
  usage: Usage;
  /** Every model call in order, with tool calls and usage per step. */
  steps: Step[];
}

/** Runs one tool call for the current request. Set by createApp for ctx.ai. */
export type ToolRunner = (route: RouteDef, input: unknown) => Promise<{ name: string; status: number; output: unknown; text: string }>;

const toolRunners = new WeakMap<AI, { runner: ToolRunner; describe: (route: RouteDef) => ToolSpec }>();

/** One model call that returns the tool calls instead of running them, for agent loops such as LangChain's. */
export interface ModelCallOptions {
  model?: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  for?: string;
  signal?: AbortSignal;
}

export interface ModelCallResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

const modelCalls = new WeakMap<AI, (options: ModelCallOptions) => Promise<ModelCallResult>>();

/**
 * One model call with the AI's aliases, fallback, budgets, usage tracking and tracing, which returns the tool calls
 * the model asked for without running them. Internal: used by the LangChain integration.
 */
export function callModel(ai: AI, options: ModelCallOptions): Promise<ModelCallResult> {
  const call = modelCalls.get(ai);
  if (!call) throw new InferloError("IL5030", "Expected an AI client made by createAI() or createApp({ ai }).", { fix: "Pass app.ai, ctx.ai or the client createAI() returns." });
  return call(options);
}

/** The route tools of ctx.ai (a request's AI client), or undefined for other clients. Internal. */
export function routeToolsOf(ai: AI): { runner: ToolRunner; describe: (route: RouteDef) => ToolSpec } | undefined {
  return toolRunners.get(ai);
}

/**
 * ctx.ai for one request: the same AI, with tools that run as the request's user, and the request's signal
 * on every call that does not pass its own. Internal: used by createApp.
 */
export function bindTools(ai: AI, runner: ToolRunner, describe: (route: RouteDef) => ToolSpec, signal?: AbortSignal): AI {
  const bound: AI = { ...ai };
  toolRunners.set(bound, { runner, describe });
  const withSignal = <T extends { signal?: AbortSignal }>(options: T): T => (signal && options && options.signal === undefined ? { ...options, signal } : options);
  bound.generate = (options) => ai.generate.call(bound, withSignal(options));
  bound.stream = (options) => ai.stream.call(bound, withSignal(options));
  bound.embed = (options) => ai.embed.call(bound, withSignal(options));
  const call = modelCalls.get(ai);
  if (call) modelCalls.set(bound, (options) => call(withSignal(options)));
  return bound;
}

/** Options of StreamResult.toResponse: a ResponseInit (status, headers) and the stream format. */
export interface StreamResponseInit extends ResponseInit {
  /** "sse" (default): Inferlo's text and done events. "ai-sdk": the AI SDK UI message stream protocol, for useChat. */
  format?: "sse" | "ai-sdk";
  /**
   * Send what tools returned to the browser (default false). Tool calls (name and arguments) and each result's status
   * are always sent; the tools' output stays on the server unless this is true.
   */
  toolOutputs?: boolean;
}

/** One event of ai.stream(...).events(): a text chunk, a tool call the model made, or what the tool returned. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | ({ type: "tool-result" } & ToolCallResult);

/** Options of ai.stream: those of ai.generate without structured output and caching. */
export type StreamOptions = Omit<GenerateOptions<undefined>, "output" | "cache">;

export interface StreamResult {
  /** Text chunks as they arrive. */
  [Symbol.asyncIterator](): AsyncIterator<string>;
  /** Text chunks, tool calls and tool results as they happen, for ai.stream({ tools }). Read the stream one way only. */
  events(): AsyncIterable<StreamEvent>;
  /** Full text once the stream finishes (every step's text, for a stream with tools). */
  text(): Promise<string>;
  /** Every model call in order, with tool calls and usage per step, once the stream finishes. */
  steps(): Promise<Step[]>;
  /**
   * A server-sent events Response for browsers. The default format sends "text" events, then "done" with usage.
   * format: "ai-sdk" speaks the AI SDK UI message stream protocol (v1), for useChat from @ai-sdk/react.
   */
  toResponse(init?: StreamResponseInit): Response;
  /** Usage once the stream finishes. */
  usage(): Promise<Usage>;
}

export interface AI {
  generate<O extends AnySchema | StandardSchema | undefined = undefined>(options: GenerateOptions<O>): Promise<GenerateResult<O extends undefined ? undefined : InferOutput<O>>>;
  stream(options: StreamOptions): StreamResult;
  embed(options: { model?: string; input: string | string[]; for?: string; signal?: AbortSignal }): Promise<{ embeddings: number[][]; usage: Usage }>;
  /** Configured aliases, for describe(). */
  readonly aliases: Record<string, string[]>;
  readonly configured: boolean;
}

interface Target {
  provider: Provider;
  providerName: string;
  model: string;
  id: string;
}

/** Where ai.generate({ cache }) keeps answers: an app's cache (app.cache), or anything with its get and set. */
export type AICache = Pick<Cache, "get" | "set">;

/** createAI's own cache for answers when no app cache is given: in memory, the least recently used removed first. */
function memoryAICache(maxEntries: number): AICache {
  const entries = new Map<string, { json: string; expires: number }>();
  return {
    async get<T>(key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (entry.expires <= Date.now()) return undefined;
      entries.set(key, entry);
      return JSON.parse(entry.json) as T;
    },
    async set(key, value, options) {
      entries.delete(key);
      entries.set(key, { json: JSON.stringify(value), expires: Date.now() + options.ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    },
  };
}

/** Checks ai.generate({ cache }). Raises IL5040. */
function checkAICache(option: unknown, tools: boolean): { ttlMs: number; tags?: readonly string[] } {
  const fix = "Pass cache: { ttlMs: 3_600_000 } (and tags to invalidate it with cache.invalidate(tag)) on ai.generate calls without tools.";
  if (!option || typeof option !== "object" || Array.isArray(option)) throw new InferloError("IL5040", "ai.generate({ cache }) must be { ttlMs, tags }.", { fix });
  const { ttlMs, tags, ...rest } = option as { ttlMs?: unknown; tags?: unknown };
  if (Object.keys(rest).length) throw new InferloError("IL5040", `ai.generate({ cache }) has unknown option ${Object.keys(rest).map((k) => `"${k}"`).join(", ")}.`, { fix });
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 365 * 24 * 3_600_000) {
    throw new InferloError("IL5040", `ai.generate({ cache: { ttlMs } }) must be a whole number of milliseconds from 1 to 365 days, got ${JSON.stringify(ttlMs)}.`, { fix });
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !t))) throw new InferloError("IL5040", "ai.generate({ cache: { tags } }) must be a list of non-empty strings.", { fix });
  if (tools) {
    throw new InferloError("IL5040", "ai.generate({ cache }) cannot be used with tools: a cached answer would skip the tool calls the model makes.", {
      fix: "Leave out cache for calls with tools, or cache the result of the tools yourself with ctx.cache.getOrSet.",
    });
  }
  return { ttlMs, ...(tags ? { tags: tags as string[] } : {}) };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** { prompt: "name@version" } for usage, when the options came from prompt.render(). */
function promptOf(options: { promptId?: unknown }): { prompt?: string } {
  return typeof options.promptId === "string" && options.promptId ? { prompt: options.promptId } : {};
}

function buildMessages(o: GenerateOptions<any>): Message[] {
  const messages: Message[] = [];
  if (o.system) messages.push({ role: "system", content: o.system });
  if (o.messages) messages.push(...o.messages.map((m) => ({ ...m })));
  if (o.images !== undefined && o.prompt === undefined) {
    throw new InferloError("IL5012", "images needs a prompt: they are sent with the prompt message.", {
      fix: 'Pass prompt: "What is in this image?" with images, or put images on a user message: messages: [{ role: "user", content: "...", images: [...] }].',
    });
  }
  if (o.prompt !== undefined) messages.push({ role: "user", content: o.prompt, ...(o.images?.length ? { images: o.images } : {}) });
  if (!messages.some((m) => m.role !== "system")) {
    throw new InferloError("IL5007", "ai.generate() needs a prompt or messages.", { fix: 'Pass prompt: "..." or messages: [{ role: "user", content: "..." }].' });
  }
  messages.forEach(checkImages);
  return messages;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Images must be on user messages, with an http(s) or data: URL, or base64 data of a supported type. Raises IL5012. */
function checkImages(message: Message, index: number): void {
  if (message.images === undefined) return;
  const fail = (problem: string, fix: string) => {
    throw new InferloError("IL5012", `Invalid image in message ${index}: ${problem}`, { fix });
  };
  const shape = 'Use { url: "https://..." } or { base64: "<base64 data>", mediaType: "image/png" }.';
  if (!Array.isArray(message.images)) fail("images must be an array.", shape);
  if (message.role !== "user" && message.images.length) fail(`only user messages can have images, not ${message.role} messages.`, "Move the images to a user message.");
  message.images.forEach((image: unknown, i) => {
    const where = `images[${i}]`;
    if (!image || typeof image !== "object") return fail(`${where} is not an object.`, shape);
    const value = image as Record<string, unknown>;
    if ("url" in value) {
      if (typeof value.url !== "string" || !/^(https?:\/\/|data:)/i.test(value.url)) return fail(`${where}.url must start with https://, http:// or data:.`, shape);
      const data = imageData(value as Image);
      if (/^data:/i.test(value.url) && !data) return fail(`${where}.url is a data: URL without base64 data.`, "Use data:image/png;base64,<data>, or { base64, mediaType }.");
      if (data && !IMAGE_TYPES.includes(data.mediaType)) return fail(`${where} has media type "${data.mediaType}".`, `Supported types: ${IMAGE_TYPES.join(", ")}.`);
      if (data && !BASE64.test(data.base64)) return fail(`${where}.url does not contain valid base64 data.`, "Encode the image bytes as base64, without line breaks.");
      return;
    }
    if ("base64" in value) {
      if (typeof value.base64 !== "string" || !value.base64 || !BASE64.test(value.base64)) return fail(`${where}.base64 is not valid base64 data.`, "Encode the image bytes as base64, without line breaks or a data: prefix.");
      if (typeof value.mediaType !== "string" || !IMAGE_TYPES.includes(value.mediaType)) return fail(`${where}.mediaType must be one of ${IMAGE_TYPES.join(", ")}.`, 'Add mediaType: "image/png" (or the type of the image).');
      return;
    }
    fail(`${where} has neither url nor base64.`, shape);
  });
}

/** Pull a JSON value out of model text, tolerating ```json fences and leading prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError("No JSON found in model output");
  }
}

interface ToolEntry {
  route?: RouteDef;
  fn?: ToolDef;
  spec: ToolSpec;
}

interface PreparedTools {
  tools: Map<string, ToolEntry>;
  specs: ToolSpec[] | undefined;
  tooling: { runner: ToolRunner; describe: (route: RouteDef) => ToolSpec } | undefined;
}

/** The tools of one ai.generate or ai.stream call, by name. Raises IL5009 for routes outside a route handler and IL5013 for duplicate names. */
function prepareTools(self: AI, list: readonly (ToolDef | RouteDef)[] | undefined, method: "generate" | "stream"): PreparedTools {
  const routeTools = (list ?? []).filter((t) => !isTool(t)) as RouteDef[];
  const tooling = routeTools.length ? toolRunners.get(self) : undefined;
  if (routeTools.length && !tooling) {
    throw new InferloError("IL5009", `Routes as tools in ai.${method}({ tools }) only work inside a route handler.`, {
      fix: `Call ctx.ai.${method}({ tools }) from a route handler, so each route runs as the signed-in user with its auth and validation, or make a function tool with tool(name, { description, input }).handle(fn), which works anywhere.`,
    });
  }
  const tools = new Map<string, ToolEntry>();
  for (const entry of list ?? []) {
    const fn = isTool(entry) ? entry : undefined;
    const spec = fn ? functionToolSpec(fn) : tooling!.describe(entry as RouteDef);
    if (tools.has(spec.name)) {
      throw new InferloError("IL5013", `Two tools are named "${spec.name}" in one ai.${method} call.`, { fix: "Give each tool a unique name (a route's tool name is its export name, or tool: { name })." });
    }
    tools.set(spec.name, fn ? { fn, spec } : { route: entry as RouteDef, spec });
  }
  return { tools, specs: tools.size ? [...tools.values()].map((t) => t.spec) : undefined, tooling };
}

/**
 * Runs one tool call the model made. Unknown tools and arguments that are not an object go back to the model as the
 * problem; ran is false for those, because nothing ran. Errors a function tool throws (other than httpError) propagate.
 */
async function runToolCall(prepared: PreparedTools, call: ToolCall, signal: AbortSignal | undefined): Promise<{ status: number; output: unknown; text: string; ran: boolean }> {
  const tool = prepared.tools.get(call.name);
  if (!tool) {
    const text = `Unknown tool "${call.name}". Available tools: ${[...prepared.tools.keys()].join(", ")}.`;
    return { status: 404, output: text, text, ran: false };
  }
  if (typeof call.input !== "object" || call.input === null || Array.isArray(call.input)) {
    const text = "Tool arguments must be a JSON object.";
    return { status: 422, output: text, text, ran: false };
  }
  const result = tool.fn ? await runFunctionTool(tool.fn, call.input, signal) : await prepared.tooling!.runner(tool.route!, call.input);
  return { status: result.status, output: result.output, text: result.text, ran: true };
}

export function createAI(config?: AIConfig): AI {
  const providers = config?.providers ?? {};
  let cacheOf: AICache | undefined;
  // Errors logged here never show the providers' API keys or other credentials.
  const redactor = createRedactor(Object.values(providers).flatMap((p) => secretsOf(p)));
  const aliases: Record<string, string[]> = {};
  for (const [alias, ids] of Object.entries(config?.models ?? {})) aliases[alias] = Array.isArray(ids) ? ids : [ids];
  const tracingConfig = checkTracing(config?.tracing, "createAI");
  const spans = tracingConfig ? clientTracing(tracingConfig, "inferlo") : undefined;
  /** Attributes of an AI span before the call (OpenTelemetry GenAI conventions, plus the alias asked for). */
  const spanStart = (operation: "chat" | "embeddings", requested: string, targets: Target[], options: { maxTokens?: number; temperature?: number; promptId?: string }) => {
    const first = targets[0]!;
    const attributes: Record<string, string | number | boolean> = {
      "gen_ai.operation.name": operation,
      "gen_ai.provider.name": first.provider.name,
      "gen_ai.request.model": first.model,
      "inferlo.ai.model": requested,
    };
    if (options.maxTokens !== undefined) attributes["gen_ai.request.max_tokens"] = options.maxTokens;
    if (options.temperature !== undefined) attributes["gen_ai.request.temperature"] = options.temperature;
    if (typeof options.promptId === "string") attributes["inferlo.ai.prompt"] = options.promptId;
    return { name: `${operation} ${first.model}`, attributes };
  };
  /** The model that answered, its tokens and cost, on the span. */
  const spanUsage = (span: OtelSpan, usage: Usage) => {
    const colon = usage.model.indexOf(":");
    const provider = providers[usage.model.slice(0, colon)];
    if (provider) span.setAttribute("gen_ai.provider.name", provider.name);
    span.setAttribute("gen_ai.response.model", usage.model.slice(colon + 1));
    span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
    span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
    span.setAttribute("inferlo.ai.cost_usd", usage.cost);
  };

  const resolve = (requested: string | undefined): Target[] => {
    const name = requested ?? config?.defaultModel ?? (Object.keys(aliases)[0] as string | undefined);
    if (!Object.keys(providers).length) {
      throw new InferloError("IL5001", "No AI providers are configured.", {
        fix: 'Add createApp({ ai: { providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) }, models: { fast: "anthropic:claude-haiku-4-5" } } }).',
      });
    }
    if (!name) throw new InferloError("IL5001", "No model given and no default model configured.", { fix: 'Pass model: "provider:model" or set ai.defaultModel.' });
    const ids = aliases[name] ?? [name];
    return ids.map((id) => {
      const colon = id.indexOf(":");
      if (colon === -1) {
        throw new InferloError("IL5001", `Unknown model or alias "${id}".${didYouMean(id, Object.keys(aliases))}`, {
          fix: `Use an alias (${Object.keys(aliases).join(", ") || "none configured"}) or "provider:model", e.g. "anthropic:claude-haiku-4-5".`,
        });
      }
      const providerName = id.slice(0, colon);
      const provider = providers[providerName];
      if (!provider) {
        throw new InferloError("IL5001", `AI provider "${providerName}" is not configured.${didYouMean(providerName, Object.keys(providers))}`, {
          fix: `Configured providers: ${Object.keys(providers).join(", ")}.`,
        });
      }
      return { provider, providerName, model: id.slice(colon + 1), id };
    });
  };

  const cost = (id: string, usage: ProviderUsage) => {
    const price = config?.pricing?.[id];
    if (!price) return 0;
    return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  };

  const record = async (usage: Usage) => {
    try {
      await config?.onUsage?.(usage);
    } catch (error) {
      console.error("[inferlo] ai.onUsage failed:", redactor.value(error));
    }
  };

  const guard = async (forId: string | undefined, model: string) => {
    if (!forId || !config?.allow) return;
    let allowed: boolean;
    try {
      allowed = await config.allow({ for: forId, model });
    } catch (error) {
      if (error instanceof InferloError) throw error;
      allowed = false;
    }
    if (!allowed) throw new InferloError("IL5004", "AI usage limit reached.", { status: 402, fix: "Add credits or raise this account's limit." });
  };

  /** Try each target in order, moving on only for retryable provider errors. */
  const withFallback = async <T>(targets: Target[], run: (t: Target) => Promise<T>): Promise<T> => {
    const errors: string[] = [];
    for (const target of targets) {
      try {
        return await run(target);
      } catch (error) {
        if (error instanceof ProviderError && error.retryable) {
          errors.push(`${target.id}: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    throw new InferloError("IL5003", `All models failed: ${targets.map((t) => t.id).join(", ")}.`, { status: 502, expose: false, details: errors });
  };

  const ai: AI = {
    aliases,
    configured: Object.keys(providers).length > 0,

    async generate(options) {
      const requested = options.model ?? config?.defaultModel ?? Object.keys(aliases)[0] ?? "";
      const targets = resolve(options.model);
      const prepared = prepareTools(this as AI, options.tools, "generate");
      const { tools, specs } = prepared;
      const adapter = options.output === undefined ? undefined : schemaAdapter(options.output);
      if (typeof adapter === "string") throw invalidOutputSchema(adapter);
      const maxSteps = Math.max(1, options.maxSteps ?? 5);
      await guard(options.for, requested);
      const messages = buildMessages(options);
      const schema = adapter;
      const jsonSchema = adapter?.jsonSchema;
      if (schema) {
        const instruction =
          "Respond with only a JSON value that matches this JSON Schema. No prose, no code fences.\n" + JSON.stringify(jsonSchema);
        const sys = messages.find((m) => m.role === "system");
        if (sys) sys.content += "\n\n" + instruction;
        else messages.unshift({ role: "system", content: instruction });
      }
      const started = Date.now();
      // Once a tool has run, falling back to another model would run it again.
      let toolsRan = false;
      const cacheOption = options.cache === undefined ? undefined : checkAICache(options.cache, Boolean(options.tools?.length));

      const call = () => withFallback(targets, async (target) => {
        const total = { inputTokens: 0, outputTokens: 0 };
        const steps: Step[] = [];
        const convo = messages.map((m) => ({ ...m }));
        let repairsLeft = schema ? Math.max(0, options.repairAttempts ?? 1) : 0;
        let toolRounds = 0;
        let lastIssues = "";
        const usageNow = (): Usage => ({ requested, model: target.id, ...total, cost: cost(target.id, total), for: options.for, kind: "generate", durationMs: Date.now() - started, ...promptOf(options) });
        while (true) {
          // Budgets are checked again before every model call that follows tool calls.
          if (steps.at(-1)?.toolCalls.length) await guard(options.for, requested);
          let response;
          try {
            response = await target.provider.generate({
              model: target.model,
              messages: convo,
              temperature: options.temperature,
              maxTokens: options.maxTokens,
              json: Boolean(schema),
              jsonSchema,
              tools: specs,
              signal: options.signal,
            });
          } catch (error) {
            if (toolsRan && error instanceof ProviderError && error.retryable) {
              if (steps.length) await record(usageNow());
              throw new InferloError("IL5006", error.message, { status: 502, expose: false, fix: "Tools already ran, so Inferlo does not retry on a fallback model. Retry the request.", cause: error });
            }
            throw error;
          }
          total.inputTokens += response.usage.inputTokens;
          total.outputTokens += response.usage.outputTokens;
          const step: Step = { text: response.text, toolCalls: [], usage: response.usage };
          steps.push(step);

          if (specs && response.toolCalls?.length) {
            if (++toolRounds >= maxSteps) {
              await record(usageNow());
              throw new InferloError("IL5010", `Model ${target.id} was still calling tools after ${maxSteps} steps.`, {
                status: 502,
                expose: false,
                fix: "Raise maxSteps, give the model fewer and more specific tools, or say in the prompt when to stop.",
                details: steps.map((s) => s.toolCalls.map((c) => c.name)),
              });
            }
            convo.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
            for (const call of response.toolCalls) {
              let result: { status: number; output: unknown; text: string; ran: boolean };
              try {
                result = await runToolCall(prepared, call, options.signal);
              } catch (error) {
                toolsRan = true;
                await record(usageNow());
                throw error;
              }
              if (result.ran) toolsRan = true;
              const isError = result.status >= 400;
              step.toolCalls.push({ id: call.id, name: call.name, input: call.input, status: result.status, output: result.output, isError });
              convo.push({ role: "tool", toolCallId: call.id, content: result.text, ...(isError ? { isError } : {}) });
            }
            continue;
          }

          if (!schema) {
            const usage = usageNow();
            await record(usage);
            return { text: response.text, object: undefined as never, usage, steps };
          }
          let parsed: unknown;
          let ok = false;
          try {
            parsed = extractJson(response.text);
            const result = await schema.validate(parsed);
            if (result.ok) {
              parsed = result.value;
              ok = true;
            } else {
              lastIssues = result.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
            }
          } catch {
            lastIssues = "The response was not valid JSON.";
          }
          if (ok) {
            const usage = usageNow();
            await record(usage);
            return { text: response.text, object: parsed as never, usage, steps };
          }
          if (repairsLeft-- <= 0) {
            await record(usageNow());
            break;
          }
          convo.push(
            { role: "assistant", content: response.text },
            {
              role: "user",
              content: lastIssues === "The response was not valid JSON." ? `${lastIssues} Reply with only the JSON value.` : `That JSON does not match the schema: ${lastIssues}. Reply with corrected JSON only.`,
            },
          );
        }
        throw new InferloError("IL5002", `Model ${target.id} did not return output matching the schema. ${lastIssues}`, {
          status: 502,
          expose: false,
          fix: "Simplify the output schema, add .describe() hints to fields, or use a stronger model.",
        });
      });
      const answer = async () => {
        if (!cacheOption) return call();
        // The key is a hash of everything that shapes the answer; the answer is stored only after it succeeded.
        const key = `inferlo:ai:${await sha256(JSON.stringify({ v: 1, models: targets.map((t) => t.id), messages, temperature: options.temperature ?? null, maxTokens: options.maxTokens ?? null, json: Boolean(schema) }))}`;
        const store = (cacheOf ??= config?.cache ?? memoryAICache(1000));
        const hit = await store.get<{ text: string; object: unknown; model: string }>(key).catch(() => undefined);
        if (hit && typeof hit.text === "string") {
          let object: unknown = undefined;
          if (schema) {
            const checked = await schema.validate(hit.object);
            if (!checked.ok) return fresh(key, store);
            object = checked.value;
          }
          const usage: Usage = { requested, model: hit.model, inputTokens: 0, outputTokens: 0, cost: 0, for: options.for, kind: "generate", durationMs: Date.now() - started, ...promptOf(options), cached: true };
          await record(usage);
          return { text: hit.text, object: object as never, usage, steps: [], cached: true };
        }
        return fresh(key, store);
      };
      const fresh = async (key: string, store: AICache) => {
        const result = await call();
        await store.set(key, { text: result.text, object: result.object ?? null, model: result.usage.model }, cacheOption!).catch((error: unknown) => {
          console.error("[inferlo] ai cache write failed:", redactor.value(error));
        });
        return result;
      };
      if (!spans) return answer();
      const { name, attributes } = spanStart("chat", requested, targets, options);
      // The span is active while the call runs, so route and function tools the model calls nest under it.
      return spans.run(name, attributes, async (span) => {
        const result = await answer();
        spanUsage(span, result.usage);
        span.setAttribute("inferlo.ai.steps", result.steps.length);
        if (result.usage.cached) span.setAttribute("inferlo.ai.cached", true);
        return result;
      });
    },

    stream(options) {
      const requested = options.model ?? config?.defaultModel ?? Object.keys(aliases)[0] ?? "";
      const self = this as AI;
      let resolveText!: (t: string) => void;
      let rejectText!: (e: unknown) => void;
      let resolveUsage!: (u: Usage) => void;
      let resolveSteps!: (s: Step[]) => void;
      const textPromise = new Promise<string>((res, rej) => ((resolveText = res), (rejectText = rej)));
      const usagePromise = new Promise<Usage>((res) => (resolveUsage = res));
      const stepsPromise = new Promise<Step[]>((res) => (resolveSteps = res));
      textPromise.catch(() => {});
      let consumed = false;

      async function* run(): AsyncGenerator<StreamEvent> {
        if (consumed) throw new InferloError("IL5008", "A stream can only be read once.", { fix: "Call ai.stream() again, or use await stream.text()." });
        consumed = true;
        const targets = resolve(options.model);
        const prepared = prepareTools(self, options.tools, "stream");
        const maxSteps = Math.max(1, options.maxSteps ?? 5);
        await guard(options.for, requested);
        const messages = buildMessages(options);
        const started = Date.now();
        let full = "";
        const start = spans && spanStart("chat", requested, targets, options);
        const span = start ? spans!.start(start.name, { ...start.attributes, "inferlo.ai.stream": true }) : undefined;
        let spanEnded = false;
        // Fallback to the next model happens only while nothing was sent and no tool ran.
        let sent = false;
        let toolsRan = false;
        const steps: Step[] = [];
        const total = { inputTokens: 0, outputTokens: 0 };
        let answered: Target | undefined;
        const usageNow = (target: Target): Usage => ({ requested, model: target.id, ...total, cost: cost(target.id, total), for: options.for, kind: "stream", durationMs: Date.now() - started, ...promptOf(options) });
        try {
          for (let i = 0; i < targets.length; i++) {
            const target = targets[i]!;
            if (!target.provider.stream) {
              throw new InferloError("IL5005", `Provider "${target.providerName}" does not support streaming.`);
            }
            const convo = messages.map((m) => ({ ...m }));
            let fellBack = false;
            while (true) {
              // Budgets are checked again before every model call that follows tool calls.
              if (steps.length) await guard(options.for, requested);
              let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
              let text = "";
              let toolCalls: ToolCall[] = [];
              try {
                for await (const part of target.provider.stream({ model: target.model, messages: convo, temperature: options.temperature, maxTokens: options.maxTokens, tools: prepared.specs, signal: options.signal })) {
                  if (typeof part === "string") {
                    if (!part) continue;
                    text += part;
                    full += part;
                    sent = true;
                    yield { type: "text", text: part };
                  } else if ("toolCalls" in part) toolCalls = toolCalls.concat(part.toolCalls);
                  else if (part.usage) usage = part.usage;
                }
              } catch (error) {
                if (error instanceof ProviderError && error.retryable && !sent && !toolsRan && i < targets.length - 1) {
                  fellBack = true;
                  break;
                }
                if (toolsRan && error instanceof ProviderError && error.retryable) {
                  await record(usageNow(target));
                  throw new InferloError("IL5006", error.message, { status: 502, expose: false, fix: "Tools already ran, so Inferlo does not retry on a fallback model. Retry the request.", cause: error });
                }
                throw error;
              }
              total.inputTokens += usage.inputTokens;
              total.outputTokens += usage.outputTokens;
              const step: Step = { text, toolCalls: [], usage };
              steps.push(step);
              if (!prepared.specs || !toolCalls.length) {
                answered = target;
                break;
              }
              if (steps.length >= maxSteps) {
                await record(usageNow(target));
                throw new InferloError("IL5010", `Model ${target.id} was still calling tools after ${maxSteps} steps.`, {
                  status: 502,
                  expose: false,
                  fix: "Raise maxSteps, give the model fewer and more specific tools, or say in the prompt when to stop.",
                  details: steps.map((s) => s.toolCalls.map((c) => c.name)),
                });
              }
              convo.push({ role: "assistant", content: text, toolCalls });
              for (const call of toolCalls) {
                sent = true;
                yield { type: "tool-call", id: call.id, name: call.name, input: call.input };
                let result: { status: number; output: unknown; text: string; ran: boolean };
                try {
                  result = await runToolCall(prepared, call, options.signal);
                } catch (error) {
                  toolsRan = true;
                  await record(usageNow(target));
                  throw error;
                }
                if (result.ran) toolsRan = true;
                const isError = result.status >= 400;
                const done: ToolCallResult = { id: call.id, name: call.name, input: call.input, status: result.status, output: result.output, isError };
                step.toolCalls.push(done);
                convo.push({ role: "tool", toolCallId: call.id, content: result.text, ...(isError ? { isError } : {}) });
                yield { type: "tool-result", ...done };
              }
            }
            if (fellBack) continue;
            const u = usageNow(answered!);
            await record(u);
            if (span) {
              spanUsage(span, u);
              if (prepared.specs) span.setAttribute("inferlo.ai.steps", steps.length);
              span.end();
              spanEnded = true;
            }
            resolveUsage(u);
            resolveSteps(steps);
            resolveText(full);
            return;
          }
        } catch (error) {
          if (span && !spanEnded) {
            spans!.fail(span, error);
            spanEnded = true;
          }
          rejectText(error);
          throw error;
        } finally {
          // The reader stopped early (the browser went away): the span ends with what was sent.
          if (span && !spanEnded) {
            span.setAttribute("inferlo.ai.cancelled", true);
            span.end();
          }
        }
      }

      let iterator: AsyncGenerator<StreamEvent> | undefined;
      const start = () => (iterator ??= run());
      async function* texts(): AsyncGenerator<string> {
        for await (const event of start()) if (event.type === "text") yield event.text;
      }

      const text = async () => {
        if (!iterator) for await (const _ of start()) void _;
        return textPromise;
      };

      return {
        [Symbol.asyncIterator]: () => texts(),
        events: () => start(),
        text,
        steps: async () => {
          await text();
          return stepsPromise;
        },
        usage: () => usagePromise,
        toResponse(init) {
          const { format = "sse", toolOutputs = false, ...responseInit } = init ?? {};
          if (format !== "sse" && format !== "ai-sdk") {
            throw new InferloError("IL5027", `Unknown stream format "${String(format)}" in toResponse({ format }).`, {
              fix: 'Use toResponse() for Inferlo\'s server-sent events, or toResponse({ format: "ai-sdk" }) for useChat from the Vercel AI SDK.',
            });
          }
          const encoder = new TextEncoder();
          const source = start();
          const aiSdk = format === "ai-sdk";
          let textId = "";
          // AI SDK UI message stream chunks are server-sent events with only a data field.
          const chunk = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
          const sse = (event: string, value: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              if (aiSdk) controller.enqueue(chunk({ type: "start" }));
            },
            async pull(controller) {
              try {
                const { value: event, done } = await source.next();
                if (done) {
                  const usage = await usagePromise;
                  if (!aiSdk) controller.enqueue(sse("done", { usage }));
                  else {
                    if (textId) controller.enqueue(chunk({ type: "text-end", id: textId }));
                    controller.enqueue(chunk({ type: "finish" }));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  }
                  controller.close();
                  return;
                }
                if (!aiSdk) {
                  if (event.type === "text") controller.enqueue(sse("text", event.text));
                  else if (event.type === "tool-call") controller.enqueue(sse("tool-call", { id: event.id, name: event.name, input: event.input }));
                  else controller.enqueue(sse("tool-result", { id: event.id, name: event.name, status: event.status, isError: event.isError, ...(toolOutputs ? { output: event.output } : {}) }));
                  return;
                }
                if (event.type === "text") {
                  if (!textId) {
                    textId = `text-${crypto.randomUUID()}`;
                    controller.enqueue(chunk({ type: "text-start", id: textId }));
                  }
                  controller.enqueue(chunk({ type: "text-delta", id: textId, delta: event.text }));
                  return;
                }
                // Text after a tool call is a new text part, as the AI SDK sends it.
                if (textId) {
                  controller.enqueue(chunk({ type: "text-end", id: textId }));
                  textId = "";
                }
                if (event.type === "tool-call") controller.enqueue(chunk({ type: "tool-input-available", toolCallId: event.id, toolName: event.name, input: event.input }));
                else if (event.isError) controller.enqueue(chunk({ type: "tool-output-error", toolCallId: event.id, errorText: `The tool answered with status ${event.status}.` }));
                else controller.enqueue(chunk({ type: "tool-output-available", toolCallId: event.id, output: toolOutputs ? event.output : null }));
              } catch (error) {
                const code = error instanceof InferloError ? error.code : "IL9000";
                if (!aiSdk) controller.enqueue(sse("error", { code }));
                else {
                  // Only the code reaches the browser; the details are logged below.
                  controller.enqueue(chunk({ type: "error", errorText: `The model call failed (${code}).` }));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                }
                controller.close();
                console.error("[inferlo] stream failed:", redactor.value(error));
              }
            },
            cancel() {
              void source.return(undefined);
            },
          });
          const headers: Record<string, string> = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" };
          if (aiSdk) {
            headers["content-type"] = "text/event-stream";
            headers["x-vercel-ai-ui-message-stream"] = "v1";
            headers["x-accel-buffering"] = "no";
          }
          return new Response(body, { ...responseInit, headers: { ...headers, ...(responseInit.headers as Record<string, string>) } });
        },
      };
    },

    async embed(options) {
      const requested = options.model ?? "embed";
      const targets = resolve(options.model ?? (aliases.embed ? "embed" : undefined));
      await guard(options.for, requested);
      const input = Array.isArray(options.input) ? options.input : [options.input];
      const started = Date.now();
      const call = () => withFallback(targets, async (target) => {
        if (!target.provider.embed) throw new InferloError("IL5005", `Provider "${target.providerName}" does not support embeddings.`);
        const result = await target.provider.embed({ model: target.model, input, signal: options.signal });
        const usage: Usage = { requested, model: target.id, ...result.usage, cost: cost(target.id, result.usage), for: options.for, kind: "embed", durationMs: Date.now() - started };
        await record(usage);
        return { embeddings: result.embeddings, usage };
      });
      if (!spans) return call();
      const { name, attributes } = spanStart("embeddings", requested, targets, {});
      return spans.run(name, attributes, async (span) => {
        const result = await call();
        spanUsage(span, result.usage);
        return result;
      });
    },
  };

  modelCalls.set(ai, async (options) => {
    const requested = options.model ?? config?.defaultModel ?? Object.keys(aliases)[0] ?? "";
    const targets = resolve(options.model);
    await guard(options.for, requested);
    if (!options.messages.some((m) => m.role !== "system")) {
      throw new InferloError("IL5007", "A model call needs at least one message besides the system message.", { fix: 'Pass messages: [{ role: "user", content: "..." }].' });
    }
    options.messages.forEach(checkImages);
    const started = Date.now();
    const call = () =>
      withFallback(targets, async (target) => {
        const response = await target.provider.generate({
          model: target.model,
          messages: options.messages,
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          tools: options.tools?.length ? options.tools : undefined,
          signal: options.signal,
        });
        const usage: Usage = { requested, model: target.id, ...response.usage, cost: cost(target.id, response.usage), for: options.for, kind: "generate", durationMs: Date.now() - started };
        await record(usage);
        return { text: response.text, toolCalls: response.toolCalls ?? [], usage };
      });
    if (!spans) return call();
    const { name, attributes } = spanStart("chat", requested, targets, options);
    return spans.run(name, attributes, async (span) => {
      const result = await call();
      spanUsage(span, result.usage);
      return result;
    });
  });
  return ai;
}

/** Cosine similarity of two vectors, for small in-memory searches. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
