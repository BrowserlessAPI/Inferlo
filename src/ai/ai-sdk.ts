/**
 * Vercel AI SDK providers as Inferlo providers: every @ai-sdk/* provider (OpenAI, Anthropic, Google,
 * Mistral, Amazon Bedrock, Azure, Vertex, Groq, xAI, the AI Gateway, ...) works with aliases, fallback,
 * usage tracking, structured output, tools, streaming and embeddings.
 *
 *   import { createMistral } from "@ai-sdk/mistral";
 *   createAI({ providers: { mistral: aiSdk(createMistral({ apiKey })) }, models: { fast: "mistral:mistral-small-latest" } })
 *
 * Inferlo has no dependency on the AI SDK: aiSdk() calls the provider's languageModel(id) and
 * embeddingModel(id) (textEmbeddingModel(id) on older providers) and speaks the model specification
 * versions v2 (ai 5), v3 (ai 6) and v4 (ai 7) itself.
 */
import { InferloError } from "../errors.ts";
import { imageData, ProviderError, type Image, type Message, type Provider, type ProviderRequest, type ProviderUsage, type ToolCall } from "./providers.ts";

/** The parts of an AI SDK language model (LanguageModelV2, V3 or V4) that Inferlo uses. */
export interface AISdkLanguageModel {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  doGenerate(options: any): PromiseLike<{ content: readonly object[]; usage: unknown }>;
  doStream(options: any): PromiseLike<{ stream: ReadableStream<any> }>;
}

/** The parts of an AI SDK embedding model (EmbeddingModelV2, V3 or V4) that Inferlo uses. */
export interface AISdkEmbeddingModel {
  readonly specificationVersion: string;
  readonly modelId: string;
  readonly maxEmbeddingsPerCall?: PromiseLike<number | undefined> | number | undefined;
  doEmbed(options: { values: string[]; abortSignal?: AbortSignal }): PromiseLike<{ embeddings: number[][]; usage?: { tokens: number } }>;
}

/**
 * An AI SDK provider: what createOpenAI(), createAnthropic(), bedrock, mistral, gateway and the others
 * return, and what customProvider() from "ai" builds. Only languageModel is required.
 */
export interface AISdkProvider {
  readonly specificationVersion?: string;
  languageModel(modelId: string): AISdkLanguageModel;
  embeddingModel?(modelId: string): AISdkEmbeddingModel;
  textEmbeddingModel?(modelId: string): AISdkEmbeddingModel;
}

type AISdkContent = { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown };

export interface AISdkOptions {
  /** Provider name in errors, usage and traces. Default: the AI SDK provider's own name (the part before the first dot, e.g. "openai"). */
  name?: string;
}

/** The specification versions aiSdk() speaks. */
const VERSIONS = new Set(["v2", "v3", "v4"]);

/**
 * Use any Vercel AI SDK provider in createAI({ providers }) or createApp({ ai: { providers } }):
 * providers: { openai: aiSdk(createOpenAI({ apiKey })) }, then models: { fast: "openai:gpt-5-mini" }.
 */
export function aiSdk(provider: AISdkProvider, options: AISdkOptions = {}): Provider {
  if (!provider || typeof provider !== "object" && typeof provider !== "function" || typeof (provider as AISdkProvider).languageModel !== "function") {
    throw new InferloError("IL5029", "aiSdk() needs an AI SDK provider, such as createOpenAI({ apiKey }) from @ai-sdk/openai.", {
      fix: 'Pass the provider, not a model: aiSdk(createOpenAI({ apiKey })) with models: { fast: "openai:gpt-5-mini" }. For single models use customProvider({ languageModels: { ... } }) from "ai".',
    });
  }
  if (options.name !== undefined && (typeof options.name !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(options.name))) {
    throw new InferloError("IL5029", `aiSdk() name must be 1 to 64 letters, digits, dots, dashes or underscores, got ${JSON.stringify(options.name)}.`);
  }
  const languageModels = new Map<string, AISdkLanguageModel>();
  const embeddingModels = new Map<string, AISdkEmbeddingModel>();
  let label = options.name;
  const nameOf = (model: { provider?: string }) => (label ??= String(model.provider ?? "ai-sdk").split(".")[0] || "ai-sdk");

  const languageModel = (id: string): AISdkLanguageModel => {
    let model = languageModels.get(id);
    if (!model) {
      model = provider.languageModel(id);
      checkVersion(model, id, "language");
      languageModels.set(id, model);
    }
    return model;
  };

  const embeddingModel = (id: string): AISdkEmbeddingModel => {
    let model = embeddingModels.get(id);
    if (!model) {
      const make = provider.embeddingModel ?? provider.textEmbeddingModel;
      if (typeof make !== "function") {
        throw new InferloError("IL5029", `The AI SDK provider${label ? ` "${label}"` : ""} has no embedding models.`, { fix: "Use an embedding model of another provider in ai.embed({ model })." });
      }
      model = make.call(provider, id);
      checkVersion(model, id, "embedding");
      embeddingModels.set(id, model);
    }
    return model;
  };

  const out: Provider = {
    get name() {
      return label ?? "ai-sdk";
    },
    async generate(r) {
      const model = languageModel(r.model);
      const name = nameOf(model);
      const v2 = model.specificationVersion === "v2";
      let result: { content: readonly AISdkContent[]; usage: unknown };
      try {
        result = (await model.doGenerate(callOptions(r, v2))) as typeof result;
      } catch (error) {
        throw providerError(name, error);
      }
      const text = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const toolCalls: ToolCall[] = result.content
        .filter((c) => c.type === "tool-call")
        .map((c) => ({ id: c.toolCallId ?? "", name: c.toolName ?? "", input: parseInput(c.input) }));
      return { text, usage: usage(result.usage), ...(toolCalls.length ? { toolCalls } : {}) };
    },
    async *stream(r) {
      const model = languageModel(r.model);
      const name = nameOf(model);
      const v2 = model.specificationVersion === "v2";
      let stream: ReadableStream<{ type: string; delta?: string; textDelta?: string; usage?: unknown; error?: unknown }>;
      try {
        ({ stream } = await model.doStream(callOptions(r, v2)));
      } catch (error) {
        throw providerError(name, error);
      }
      const reader = stream.getReader();
      let total: ProviderUsage | undefined;
      try {
        while (true) {
          const { done, value: part } = await reader.read();
          if (done) break;
          if (part.type === "text-delta") {
            const text = part.delta ?? part.textDelta;
            if (text) yield text;
          } else if (part.type === "finish") total = usage(part.usage);
          else if (part.type === "error") throw providerError(name, part.error);
        }
      } finally {
        reader.releaseLock();
      }
      yield { usage: total ?? { inputTokens: 0, outputTokens: 0 } };
    },
    async embed({ model: id, input, signal }) {
      const model = embeddingModel(id);
      const name = nameOf({ provider: (model as { provider?: string }).provider });
      const max = (await model.maxEmbeddingsPerCall) ?? input.length;
      const embeddings: number[][] = [];
      let tokens = 0;
      for (let i = 0; i < input.length; i += Math.max(1, max)) {
        let result: { embeddings: number[][]; usage?: { tokens: number } };
        try {
          result = await model.doEmbed({ values: input.slice(i, i + Math.max(1, max)), abortSignal: signal });
        } catch (error) {
          throw providerError(name, error);
        }
        embeddings.push(...result.embeddings.map((e) => Array.from(e)));
        tokens += result.usage?.tokens ?? 0;
      }
      return { embeddings, usage: { inputTokens: tokens, outputTokens: 0 } };
    },
  };
  return out;
}

function checkVersion(model: { specificationVersion?: unknown } | undefined, id: string, kind: string): void {
  if (!model || typeof model !== "object" || !VERSIONS.has(String(model.specificationVersion))) {
    throw new InferloError("IL5029", `The AI SDK ${kind} model "${id}" uses specification ${String(model?.specificationVersion ?? "(none)")}, which aiSdk() does not speak.`, {
      fix: "Use a provider package made for ai 5 or later (@ai-sdk/* 2.0 or later, LanguageModelV2, V3 or V4).",
    });
  }
}

/** Inferlo's request as AI SDK call options. v2 file parts carry data or a URL directly; v3 and v4 wrap it. */
function callOptions(r: ProviderRequest, v2: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { prompt: prompt(r.messages, v2), abortSignal: r.signal };
  if (r.maxTokens !== undefined) out.maxOutputTokens = r.maxTokens;
  if (r.temperature !== undefined) out.temperature = r.temperature;
  if (r.json) out.responseFormat = r.jsonSchema ? { type: "json", schema: r.jsonSchema, name: "output" } : { type: "json" };
  if (r.tools?.length) {
    out.tools = r.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    out.toolChoice = { type: "auto" };
  }
  return out;
}

function prompt(messages: Message[], v2: boolean): unknown[] {
  const names = new Map<string, string>();
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") out.push({ role: "system", content: m.content });
    else if (m.role === "user") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const image of m.images ?? []) content.push(filePart(image, v2));
      out.push({ role: "user", content: content.length ? content : [{ type: "text", text: "" }] });
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        names.set(call.id, call.name);
        content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.input ?? {} });
      }
      out.push({ role: "assistant", content });
    } else {
      const id = m.toolCallId ?? "";
      const part = { type: "tool-result", toolCallId: id, toolName: names.get(id) ?? "", output: { type: m.isError ? "error-text" : "text", value: m.content } };
      // Results of one assistant turn's calls go in one tool message, as the AI SDK expects.
      const last = out.at(-1) as { role: string; content: unknown[] } | undefined;
      if (last?.role === "tool") last.content.push(part);
      else out.push({ role: "tool", content: [part] });
    }
  }
  return out;
}

function filePart(image: Image, v2: boolean): unknown {
  const data = imageData(image);
  if (v2) return data ? { type: "file", data: data.base64, mediaType: data.mediaType } : { type: "file", data: new URL((image as { url: string }).url), mediaType: "image/*" };
  return data
    ? { type: "file", data: { type: "data", data: data.base64 }, mediaType: data.mediaType }
    : { type: "file", data: { type: "url", url: new URL((image as { url: string }).url) }, mediaType: "image/*" };
}

/** Tool call arguments: v2 to v4 send them as a JSON string. */
function parseInput(input: unknown): unknown {
  if (typeof input !== "string") return input ?? {};
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/** Usage of v2 ({ inputTokens: number }) and v3/v4 ({ inputTokens: { total } }). */
function usage(raw: unknown): ProviderUsage {
  const u = (raw ?? {}) as { inputTokens?: unknown; outputTokens?: unknown };
  const count = (value: unknown): number => {
    const n = typeof value === "object" && value !== null ? (value as { total?: unknown }).total : value;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  };
  return { inputTokens: count(u.inputTokens), outputTokens: count(u.outputTokens) };
}

/** AI SDK errors (APICallError has statusCode) as ProviderError, so fallback and IL5006 work as with other providers. */
function providerError(name: string, error: unknown): unknown {
  if (error instanceof InferloError) return error;
  if (error && typeof error === "object" && (error as Error).name === "AbortError") return error;
  const e = (error ?? {}) as { statusCode?: unknown; message?: unknown; responseBody?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : 0;
  const body = typeof e.responseBody === "string" && e.responseBody ? e.responseBody : String(e.message ?? error);
  const wrapped = new ProviderError(name, status, body);
  (wrapped as { cause?: unknown }).cause = error;
  return wrapped;
}
