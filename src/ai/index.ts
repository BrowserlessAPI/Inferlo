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
import { type AnySchema, type Infer, toJSONSchema } from "../schema.ts";
import { ProviderError, type Message, type Provider, type ProviderUsage } from "./providers.ts";

export * from "./providers.ts";

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
  /** Called after every call. Store it, bill it, log it. */
  onUsage?: (usage: Usage) => void | Promise<void>;
  /**
   * Called before a call that has `for` set. Return false (or throw) to block it,
   * e.g. when a user has used up their credits. Blocked calls raise IL5004 (HTTP 402).
   */
  allow?: (info: { for: string; model: string }) => boolean | Promise<boolean>;
}

export interface GenerateOptions<O extends AnySchema | undefined> {
  /** Alias ("fast") or "provider:model". */
  model?: string;
  /** Shorthand for a single user message. */
  prompt?: string;
  system?: string;
  messages?: Message[];
  /** Schema for structured output. The result's `object` is validated and typed. */
  output?: O;
  temperature?: number;
  maxTokens?: number;
  /** Who this call is for (user or tenant id), for usage tracking and budgets. */
  for?: string;
  signal?: AbortSignal;
  /** Extra attempts when structured output does not match the schema (default 1). */
  repairAttempts?: number;
}

export interface GenerateResult<O> {
  text: string;
  object: O;
  usage: Usage;
}

export interface StreamResult {
  /** Text chunks as they arrive. */
  [Symbol.asyncIterator](): AsyncIterator<string>;
  /** Full text once the stream finishes. */
  text(): Promise<string>;
  /** A server-sent events Response for browsers (events: "text", then "done" with usage). */
  toResponse(init?: ResponseInit): Response;
  /** Usage once the stream finishes. */
  usage(): Promise<Usage>;
}

export interface AI {
  generate<O extends AnySchema | undefined = undefined>(options: GenerateOptions<O>): Promise<GenerateResult<O extends AnySchema ? Infer<O> : undefined>>;
  stream(options: Omit<GenerateOptions<undefined>, "output">): StreamResult;
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

function buildMessages(o: GenerateOptions<any>): Message[] {
  const messages: Message[] = [];
  if (o.system) messages.push({ role: "system", content: o.system });
  if (o.messages) messages.push(...o.messages);
  if (o.prompt !== undefined) messages.push({ role: "user", content: o.prompt });
  if (!messages.some((m) => m.role !== "system")) {
    throw new InferloError("IL5007", "ai.generate() needs a prompt or messages.", { fix: 'Pass prompt: "..." or messages: [{ role: "user", content: "..." }].' });
  }
  return messages;
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

export function createAI(config?: AIConfig): AI {
  const providers = config?.providers ?? {};
  const aliases: Record<string, string[]> = {};
  for (const [alias, ids] of Object.entries(config?.models ?? {})) aliases[alias] = Array.isArray(ids) ? ids : [ids];

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
      console.error("[inferlo] ai.onUsage failed:", error);
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
      await guard(options.for, requested);
      const messages = buildMessages(options);
      const schema = options.output;
      const jsonSchema = schema ? toJSONSchema(schema) : undefined;
      if (schema) {
        const instruction =
          "Respond with only a JSON value that matches this JSON Schema. No prose, no code fences.\n" + JSON.stringify(jsonSchema);
        const sys = messages.find((m) => m.role === "system");
        if (sys) sys.content += "\n\n" + instruction;
        else messages.unshift({ role: "system", content: instruction });
      }
      const started = Date.now();

      return withFallback(targets, async (target) => {
        const total = { inputTokens: 0, outputTokens: 0 };
        const convo = messages.map((m) => ({ ...m }));
        const attempts = schema ? 1 + Math.max(0, options.repairAttempts ?? 1) : 1;
        let lastIssues = "";
        for (let attempt = 0; attempt < attempts; attempt++) {
          const response = await target.provider.generate({
            model: target.model,
            messages: convo,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            json: Boolean(schema),
            jsonSchema,
            signal: options.signal,
          });
          total.inputTokens += response.usage.inputTokens;
          total.outputTokens += response.usage.outputTokens;
          const usage: Usage = {
            requested,
            model: target.id,
            ...total,
            cost: cost(target.id, total),
            for: options.for,
            kind: "generate",
            durationMs: Date.now() - started,
          };
          if (!schema) {
            await record(usage);
            return { text: response.text, object: undefined as never, usage };
          }
          let parsed: unknown;
          try {
            parsed = extractJson(response.text);
          } catch {
            lastIssues = "The response was not valid JSON.";
            convo.push({ role: "assistant", content: response.text }, { role: "user", content: `${lastIssues} Reply with only the JSON value.` });
            if (attempt === attempts - 1) await record(usage);
            continue;
          }
          const result = schema.safeParse(parsed);
          if (result.ok) {
            await record(usage);
            return { text: response.text, object: result.value as never, usage };
          }
          lastIssues = result.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
          convo.push({ role: "assistant", content: response.text }, { role: "user", content: `That JSON does not match the schema: ${lastIssues}. Reply with corrected JSON only.` });
          if (attempt === attempts - 1) await record(usage);
        }
        throw new InferloError("IL5002", `Model ${target.id} did not return output matching the schema. ${lastIssues}`, {
          status: 502,
          expose: false,
          fix: "Simplify the output schema, add .describe() hints to fields, or use a stronger model.",
        });
      });
    },

    stream(options) {
      const requested = options.model ?? config?.defaultModel ?? Object.keys(aliases)[0] ?? "";
      let resolveText!: (t: string) => void;
      let rejectText!: (e: unknown) => void;
      let resolveUsage!: (u: Usage) => void;
      const textPromise = new Promise<string>((res, rej) => ((resolveText = res), (rejectText = rej)));
      const usagePromise = new Promise<Usage>((res) => (resolveUsage = res));
      textPromise.catch(() => {});
      let consumed = false;

      async function* run(): AsyncGenerator<string> {
        if (consumed) throw new InferloError("IL5008", "A stream can only be read once.", { fix: "Call ai.stream() again, or use await stream.text()." });
        consumed = true;
        const targets = resolve(options.model);
        await guard(options.for, requested);
        const messages = buildMessages(options);
        const started = Date.now();
        let full = "";
        try {
          for (let i = 0; i < targets.length; i++) {
            const target = targets[i]!;
            if (!target.provider.stream) {
              throw new InferloError("IL5005", `Provider "${target.providerName}" does not support streaming.`);
            }
            let usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
            try {
              for await (const part of target.provider.stream({ model: target.model, messages, temperature: options.temperature, maxTokens: options.maxTokens, signal: options.signal })) {
                if (typeof part === "string") {
                  full += part;
                  yield part;
                } else usage = part.usage;
              }
            } catch (error) {
              // Fall back only if nothing was sent yet.
              if (error instanceof ProviderError && error.retryable && full === "" && i < targets.length - 1) continue;
              throw error;
            }
            const u: Usage = { requested, model: target.id, ...usage, cost: cost(target.id, usage), for: options.for, kind: "stream", durationMs: Date.now() - started };
            await record(u);
            resolveUsage(u);
            resolveText(full);
            return;
          }
        } catch (error) {
          rejectText(error);
          throw error;
        }
      }

      let iterator: AsyncGenerator<string> | undefined;
      const start = () => (iterator ??= run());

      return {
        [Symbol.asyncIterator]: () => start(),
        async text() {
          if (!iterator) for await (const _ of start()) void _;
          return textPromise;
        },
        usage: () => usagePromise,
        toResponse(init) {
          const encoder = new TextEncoder();
          const source = start();
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { value, done } = await source.next();
                if (done) {
                  const usage = await usagePromise;
                  controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ usage })}\n\n`));
                  controller.close();
                  return;
                }
                controller.enqueue(encoder.encode(`event: text\ndata: ${JSON.stringify(value)}\n\n`));
              } catch (error) {
                const code = error instanceof InferloError ? error.code : "IL9000";
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ code })}\n\n`));
                controller.close();
                console.error("[inferlo] stream failed:", error);
              }
            },
            cancel() {
              void source.return(undefined);
            },
          });
          return new Response(body, {
            ...init,
            headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", ...(init?.headers as Record<string, string>) },
          });
        },
      };
    },

    async embed(options) {
      const requested = options.model ?? "embed";
      const targets = resolve(options.model ?? (aliases.embed ? "embed" : undefined));
      await guard(options.for, requested);
      const input = Array.isArray(options.input) ? options.input : [options.input];
      const started = Date.now();
      return withFallback(targets, async (target) => {
        if (!target.provider.embed) throw new InferloError("IL5005", `Provider "${target.providerName}" does not support embeddings.`);
        const result = await target.provider.embed({ model: target.model, input, signal: options.signal });
        const usage: Usage = { requested, model: target.id, ...result.usage, cost: cost(target.id, result.usage), for: options.for, kind: "embed", durationMs: Date.now() - started };
        await record(usage);
        return { embeddings: result.embeddings, usage };
      });
    },
  };
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
