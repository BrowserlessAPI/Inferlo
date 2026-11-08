/**
 * Inferlo's AI client as a Vercel AI SDK language model, and Inferlo tools as AI SDK tools, for generateText,
 * streamText and the AI SDK's agents (and for frameworks built on AI SDK models, such as Mastra):
 *
 *   import { generateText, stepCountIs } from "ai";
 *   const { text } = await generateText({
 *     model: toAISdkModel(ctx.ai, { model: "fast", for: user.id }),
 *     tools: toAISdkTools([getWeather, createTicket], { ai: ctx.ai }),
 *     stopWhen: stepCountIs(5),
 *     prompt: body.question,
 *   });
 *
 * The model implements the AI SDK's language model specification v2, which ai 5, 6 and 7 accept; its calls keep
 * Inferlo's aliases, fallback across providers, budgets, usage tracking and tracing. No AI SDK package is imported.
 */
import { InferloError } from "../errors.ts";
import type { RouteDef } from "../route.ts";
import { callModel, extractJson, routeToolsOf, type AI } from "./index.ts";
import type { Image, ImageMediaType, Message, ToolSpec } from "./providers.ts";
import { functionToolSpec, isTool, runFunctionTool, type ToolDef } from "./tool.ts";

export interface AISdkModelOptions {
  /** Alias ("fast") or "provider:model". Default: the AI's default model. */
  model?: string;
  /** Who the calls are for (user or tenant id), for usage tracking and budgets. */
  for?: string;
}

const invalidWith = (code: string) => (message: string, fix: string) => new InferloError(code, message, { fix });

type Item = Record<string, any>;

/** A warning in the AI SDK's format, for settings Inferlo does not pass on. */
export type AISdkCallWarning = { type: "unsupported-setting"; setting: string; details?: string } | { type: "other"; message: string };

/** The AI SDK's call options (LanguageModelV2CallOptions) as far as Inferlo uses them. */
export interface AISdkCallOptions {
  prompt: Item[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseFormat?: { type: "text" } | { type: "json"; schema?: unknown; name?: string; description?: string };
  tools?: Item[];
  toolChoice?: { type: "auto" | "none" | "required" | "tool"; toolName?: string };
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  providerOptions?: unknown;
}

/** One part of a generated answer: text or a tool call (input is the arguments as JSON text). */
export type AISdkContent = { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: string };

export interface AISdkGenerateResult {
  content: AISdkContent[];
  finishReason: "stop" | "tool-calls";
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  providerMetadata: { inferlo: { model: string; requested: string; cost: number | null } };
  request: { body?: unknown };
  response: { id: string; modelId: string; timestamp: Date };
  warnings: AISdkCallWarning[];
}

/** The parts doStream() sends: the answer's text, its tool calls and the finish part with usage. */
export type AISdkStreamPart =
  | { type: "stream-start"; warnings: AISdkCallWarning[] }
  | { type: "response-metadata"; id: string; modelId: string; timestamp: Date }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: "finish"; finishReason: AISdkGenerateResult["finishReason"]; usage: AISdkGenerateResult["usage"]; providerMetadata: AISdkGenerateResult["providerMetadata"] };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A file part of a user message as an Inferlo image. Other files have no Inferlo counterpart. */
function imageOf(part: Item, code: string): Image {
  const invalid = invalidWith(code);
  const mediaType = String(part.mediaType ?? part.mimeType ?? "");
  const type = mediaType === "image/*" || mediaType === "image" ? "" : mediaType;
  if (type && !IMAGE_TYPES.has(type)) {
    throw invalid(`A message has a ${type} file, and Inferlo's models take images only (PNG, JPEG, GIF and WebP).`, "Send images, or put the file's text in the message.");
  }
  const data = part.data ?? part.image;
  if (data instanceof URL) return { url: data.href };
  if (typeof data === "string") {
    if (/^(https?|data):/i.test(data)) return { url: data };
    if (!type) throw invalid("An image in a message has base64 data without a media type.", 'Give the image a mediaType such as "image/png".');
    return { base64: data, mediaType: type as ImageMediaType };
  }
  if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
    if (!type) throw invalid("An image in a message has bytes without a media type.", 'Give the image a mediaType such as "image/png".');
    return { base64: base64Of(data instanceof Uint8Array ? data : new Uint8Array(data)), mediaType: type as ImageMediaType };
  }
  throw invalid("An image in a message has no data.", "Give the image a URL, base64 data or bytes.");
}

/** A tool result's output (AI SDK ToolResultOutput, or a plain value) as text. */
function resultText(output: unknown): { text: string; isError: boolean } {
  if (output && typeof output === "object" && "type" in output && "value" in output) {
    const o = output as Item;
    const isError = o.type === "error-text" || o.type === "error-json";
    if (o.type === "text" || o.type === "error-text") return { text: String(o.value), isError };
    if (o.type === "content" && Array.isArray(o.value)) return { text: (o.value as Item[]).map((p) => (p.type === "text" ? String(p.text) : "")).join(""), isError };
    return { text: typeof o.value === "string" ? o.value : JSON.stringify(o.value), isError };
  }
  return { text: typeof output === "string" ? output : JSON.stringify(output ?? null), isError: false };
}

/** Text of a message content (a string or a list of parts). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? (content as Item[]) : []).map((p) => (p && p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

/**
 * The AI SDK's prompt (system, user, assistant and tool messages) as Inferlo messages. Reasoning parts and
 * provider-executed tool calls have no Inferlo counterpart and are left out.
 */
export function aiSdkPromptToMessages(prompt: readonly Item[], code = "IL5035"): Message[] {
  const messages: Message[] = [];
  for (const message of prompt) {
    if (message.role === "system") messages.push({ role: "system", content: textOf(message.content) });
    else if (message.role === "user") {
      let text = "";
      const images: Image[] = [];
      for (const part of typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as Item[])) {
        if (part.type === "text") text += part.text;
        else if (part.type === "file" || part.type === "image") images.push(imageOf(part, code));
      }
      messages.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
    } else if (message.role === "assistant") {
      const out: Message = { role: "assistant", content: "" };
      const results: Message[] = [];
      for (const part of typeof message.content === "string" ? [{ type: "text", text: message.content }] : (message.content as Item[])) {
        if (part.type === "text") out.content += part.text;
        else if (part.type === "tool-call" && !part.providerExecuted) {
          let input = part.input ?? part.args;
          if (typeof input === "string") {
            try {
              input = JSON.parse(input || "{}");
            } catch {
              input = {};
            }
          }
          out.toolCalls = [...(out.toolCalls ?? []), { id: String(part.toolCallId), name: String(part.toolName), input: input ?? {} }];
        } else if (part.type === "tool-result" && !part.providerExecuted) {
          const { text, isError } = resultText(part.output ?? part.result);
          results.push({ role: "tool", content: text, toolCallId: String(part.toolCallId), ...(isError ? { isError } : {}) });
        }
      }
      messages.push(out, ...results);
    } else if (message.role === "tool") {
      for (const part of message.content as Item[]) {
        if (part.type !== "tool-result") continue;
        const { text, isError } = resultText(part.output ?? part.result);
        messages.push({ role: "tool", content: text, toolCallId: String(part.toolCallId), ...(isError ? { isError } : {}) });
      }
    }
  }
  return messages;
}

/** What the model says in errors: the error code and how to give the agent tools. Internal. */
export interface AISdkIntegration {
  code: string;
  tools: string;
}

const AI_SDK: AISdkIntegration = { code: "IL5035", tools: "Use function tools (tool() from ai, or toAISdkTools())" };

/** Inferlo's AI client as an AI SDK language model (specification v2). Make one with toAISdkModel(ai, { model }). */
export class InferloAISdkModel {
  readonly specificationVersion = "v2" as const;
  readonly provider = "inferlo";
  readonly modelId: string;
  /** Inferlo downloads image URLs itself (or the provider does), so Mastra passes them on as they are. */
  readonly supportedUrls: Record<string, RegExp[]> = { "image/*": [/^https?:\/\/.*$/] };
  readonly ai: AI;
  readonly options: AISdkModelOptions;

  /** Error code and wording of the integration that made this model. */
  readonly integration: AISdkIntegration;

  constructor(ai: AI, options: AISdkModelOptions = {}, integration: AISdkIntegration = AI_SDK) {
    this.ai = ai;
    this.options = options;
    this.modelId = options.model ?? "default";
    this.integration = integration;
  }

  async doGenerate(options: AISdkCallOptions): Promise<AISdkGenerateResult> {
    const warnings: AISdkCallWarning[] = [];
    for (const setting of ["topP", "topK", "stopSequences", "presencePenalty", "frequencyPenalty", "seed"] as const) {
      if (options[setting] !== undefined) warnings.push({ type: "unsupported-setting", setting, details: "Inferlo's AI client does not pass this setting on." });
    }
    const messages = aiSdkPromptToMessages(options.prompt ?? [], this.integration.code);
    const format = options.responseFormat;
    const json = format?.type === "json";
    if (json) {
      const instruction =
        "Respond with only a JSON value" + (format.schema ? " that matches this JSON Schema" : "") + ". No prose, no code fences." + (format.schema ? "\n" + JSON.stringify(format.schema) : "");
      const sys = messages.find((m) => m.role === "system");
      if (sys) sys.content += "\n\n" + instruction;
      else messages.unshift({ role: "system", content: instruction });
    }
    const choice = options.toolChoice?.type ?? "auto";
    if (choice === "required" || choice === "tool") warnings.push({ type: "unsupported-setting", setting: "toolChoice", details: "Inferlo lets the model choose whether to call a tool." });
    let tools: ToolSpec[] | undefined;
    if (choice !== "none") {
      for (const t of options.tools ?? []) {
        if (t.type !== "function") {
          throw new InferloError(this.integration.code, `The call uses the provider tool "${t.name ?? t.id}", which only that provider's own models run.`, { fix: `${this.integration.tools} with Inferlo's model, or use that provider's model for this call.` });
        }
        if (choice === "tool" && t.name !== options.toolChoice?.toolName) continue;
        (tools ??= []).push({ name: String(t.name), description: String(t.description ?? ""), inputSchema: (t.inputSchema ?? t.parameters ?? { type: "object", properties: {} }) as Record<string, unknown> });
      }
    }
    const result = await callModel(this.ai, {
      model: this.options.model,
      messages,
      tools,
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.maxOutputTokens === "number" ? { maxTokens: options.maxOutputTokens } : {}),
      for: this.options.for,
      signal: options.abortSignal,
    });
    let text = result.text;
    // The AI SDK parses a structured answer itself: give it the JSON without fences or prose around it.
    if (json && !result.toolCalls.length) {
      try {
        text = JSON.stringify(extractJson(text));
      } catch {
        // Left as it is; the AI SDK reports that the output does not match.
      }
    }
    const content: AISdkContent[] = [];
    if (text) content.push({ type: "text", text });
    for (const call of result.toolCalls) content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input ?? {}) });
    return {
      content,
      finishReason: result.toolCalls.length ? "tool-calls" : "stop",
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.inputTokens + result.usage.outputTokens },
      providerMetadata: { inferlo: { model: result.usage.model, requested: result.usage.requested, cost: result.usage.cost ?? null } },
      request: {},
      response: { id: `inferlo-${crypto.randomUUID()}`, modelId: result.usage.model, timestamp: new Date() },
      warnings,
    };
  }

  /** The answer as one text delta, then the tool calls and a finish part (Inferlo returns tool calls with the whole answer). */
  async doStream(options: AISdkCallOptions): Promise<{ stream: ReadableStream<AISdkStreamPart>; request: { body?: unknown }; response: { headers?: Record<string, string> } }> {
    const result = await this.doGenerate(options);
    const parts: AISdkStreamPart[] = [{ type: "stream-start", warnings: result.warnings }, { type: "response-metadata", ...result.response }];
    result.content.forEach((part, i) => {
      if (part.type === "text") parts.push({ type: "text-start", id: `text-${i}` }, { type: "text-delta", id: `text-${i}`, delta: part.text }, { type: "text-end", id: `text-${i}` });
      else parts.push(part);
    });
    parts.push({ type: "finish", finishReason: result.finishReason, usage: result.usage, providerMetadata: result.providerMetadata });
    return {
      stream: new ReadableStream<AISdkStreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
      request: {},
      response: {},
    };
  }
}

/**
 * A JSON Schema in the AI SDK's schema format, which AI SDK 5 and later and every Mastra 1.x release accept as a tool's input schema.
 * Validation passes the input through: Inferlo validates it when the tool runs and answers the model with the problems.
 */
export function aiSdkSchema(schema: Record<string, unknown>) {
  return {
    [Symbol.for("vercel.ai.schema")]: true,
    [Symbol.for("vercel.ai.validator")]: true,
    _type: undefined,
    jsonSchema: schema,
    validate: (value: unknown) => ({ success: true as const, value }),
  };
}

/**
 * An AI SDK language model that calls Inferlo's AI: toAISdkModel(ctx.ai, { model: "fast", for: user.id }). Pass it as
 * the model of generateText, streamText, generateObject or an AI SDK Agent; the calls then get Inferlo's aliases,
 * fallback, budgets and usage.
 */
export function toAISdkModel(ai: AI, options: AISdkModelOptions = {}): InferloAISdkModel {
  checkModelArgs(ai, options, "toAISdkModel", "IL5035", "Set temperature and maxOutputTokens in the generateText() call.");
  return new InferloAISdkModel(ai, { ...options });
}

/** Checks the arguments of toAISdkModel and the integrations built on it. Internal. */
export function checkModelArgs(ai: AI, options: AISdkModelOptions, name: string, code: string, settings: string): void {
  if (!ai || typeof ai !== "object" || typeof (ai as AI).generate !== "function") {
    throw new InferloError(code, `${name}(ai) needs Inferlo's AI client.`, { fix: `Pass ctx.ai in a route handler or job, app.ai, or the client createAI() returns: ${name}(ctx.ai, { model: "fast" }).` });
  }
  if (options === null || typeof options !== "object") throw new InferloError(code, `${name}() options must be an object.`, { fix: `Use ${name}(ai, { model: "fast" }).` });
  for (const key of Object.keys(options)) {
    if (key !== "model" && key !== "for") throw new InferloError(code, `Unknown ${name}() option "${key}".`, { fix: `Options: model and for. ${settings}` });
  }
}

/** An Inferlo tool as the AI SDK sees it: description, JSON Schema input and execute. */
export interface AISdkTool {
  type: "function";
  description: string;
  /** The tool's JSON Schema in the AI SDK's schema format (what jsonSchema() from ai returns). */
  inputSchema: any;
  execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<string>;
}

/** The name, schema and runner of each Inferlo tool (function tools and routes). Internal. */
export function inferloToolRunners(tools: readonly (ToolDef | RouteDef)[], ai: AI | undefined, name: string, code: string): { spec: ToolSpec; run: (input: unknown, signal: AbortSignal | undefined) => Promise<string> }[] {
  if (!Array.isArray(tools)) throw new InferloError(code, `${name}() needs an array of tools.`, { fix: "Pass [getWeather, createTicket]: function tools and routes." });
  const routeTools = ai ? routeToolsOf(ai) : undefined;
  const names = new Set<string>();
  return tools.map((entry) => {
    let spec: ToolSpec;
    let run: (input: unknown, signal: AbortSignal | undefined) => Promise<string>;
    if (isTool(entry)) {
      spec = functionToolSpec(entry);
      run = async (input, signal) => (await runFunctionTool(entry, input, signal)).text;
    } else if (entry && typeof entry === "object" && "path" in entry && "method" in entry) {
      if (!routeTools) {
        throw new InferloError("IL5009", `Routes as tools need the AI client of a request.`, {
          fix: `Call ${name}([createTicket], { ai: ctx.ai }) in a route handler, so each route runs as the signed-in user with its auth and validation, or make a function tool with tool(name, { description, input }).handle(fn).`,
        });
      }
      const route = entry as RouteDef;
      spec = routeTools.describe(route);
      run = async (input) => (await routeTools.runner(route, input)).text;
    } else {
      throw new InferloError(code, `${name}() takes function tools made with tool(...).handle(fn) and routes.`, { fix: "Pass [getWeather, createTicket]." });
    }
    if (names.has(spec.name)) throw new InferloError("IL5013", `Two tools are named "${spec.name}".`, { fix: "Give each tool a unique name (a route's tool name is its export name, or tool: { name })." });
    names.add(spec.name);
    return { spec, run };
  });
}

const parseInput = (input: unknown) => (typeof input === "string" ? JSON.parse(input || "{}") : (input ?? {}));

/**
 * Inferlo tools as AI SDK tools, keyed by name for generateText({ tools }). Function tools (tool(name, ...).handle(fn))
 * work anywhere; routes work with a request's AI client ({ ai: ctx.ai }) and run as the signed-in user, with the
 * route's auth and validation. Invalid input goes back to the model as the problem.
 */
export function toAISdkTools(tools: readonly (ToolDef | RouteDef)[], options: { ai?: AI } = {}): Record<string, AISdkTool> {
  const out: Record<string, AISdkTool> = {};
  for (const { spec, run } of inferloToolRunners(tools, options.ai, "toAISdkTools", "IL5035")) {
    out[spec.name] = { type: "function", description: spec.description, inputSchema: aiSdkSchema(spec.inputSchema), execute: (input, opts) => run(parseInput(input), opts?.abortSignal) };
  }
  return out;
}
