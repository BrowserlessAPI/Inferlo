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
import type { RouteDef } from "../route.ts";
import { functionToolSpec, isTool, runFunctionTool, type ToolDef } from "./tool.ts";
import { ProviderError, imageData, type Image, type Message, type Provider, type ProviderUsage, type ToolSpec } from "./providers.ts";

export * from "./providers.ts";
export { tool, isTool, ToolBuilder } from "./tool.ts";
export type { ToolDef, FunctionToolOptions, ToolContext } from "./tool.ts";

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
  /** Images for the prompt message: [{ url: "https://..." }] or [{ base64, mediaType: "image/png" }]. Needs a vision model. */
  images?: Image[];
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
  /**
   * Tools the model may call: functions made with tool(name, { description, input }).handle(fn), which work
   * anywhere, and routes, which run with the current user's permissions and only work through ctx.ai
   * inside a route handler: ctx.ai.generate({ prompt, tools: [getWeather, createTicket] }).
   */
  tools?: readonly (ToolDef | RouteDef)[];
  /** Most model calls when tools are given: tool rounds plus the final answer (default 5). More raises IL5010. */
  maxSteps?: number;
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
  /** Totals over every step. */
  usage: Usage;
  /** Every model call in order, with tool calls and usage per step. */
  steps: Step[];
}

/** Runs one tool call for the current request. Set by createApp for ctx.ai. */
export type ToolRunner = (route: RouteDef, input: unknown) => Promise<{ name: string; status: number; output: unknown; text: string }>;

const toolRunners = new WeakMap<AI, { runner: ToolRunner; describe: (route: RouteDef) => ToolSpec }>();

/** ctx.ai for one request: the same AI, with tools that run as the request's user. Internal: used by createApp. */
export function bindTools(ai: AI, runner: ToolRunner, describe: (route: RouteDef) => ToolSpec): AI {
  const bound: AI = { ...ai };
  toolRunners.set(bound, { runner, describe });
  bound.generate = (options) => ai.generate.call(bound, options);
  return bound;
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
  stream(options: Omit<GenerateOptions<undefined>, "output" | "tools" | "maxSteps">): StreamResult;
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
      const routeTools = (options.tools ?? []).filter((t) => !isTool(t)) as RouteDef[];
      const tooling = routeTools.length ? toolRunners.get(this as AI) : undefined;
      if (routeTools.length && !tooling) {
        throw new InferloError("IL5009", "Routes as tools in ai.generate({ tools }) only work inside a route handler.", {
          fix: "Call ctx.ai.generate({ tools }) from a route handler, so each route runs as the signed-in user with its auth and validation, or make a function tool with tool(name, { description, input }).handle(fn), which works anywhere.",
        });
      }
      const tools = new Map<string, { route?: RouteDef; fn?: ToolDef; spec: ToolSpec }>();
      for (const entry of options.tools ?? []) {
        const fn = isTool(entry) ? entry : undefined;
        const spec = fn ? functionToolSpec(fn) : tooling!.describe(entry as RouteDef);
        if (tools.has(spec.name)) {
          throw new InferloError("IL5013", `Two tools are named "${spec.name}" in one ai.generate call.`, { fix: "Give each tool a unique name (a route's tool name is its export name, or tool: { name })." });
        }
        tools.set(spec.name, fn ? { fn, spec } : { route: entry as RouteDef, spec });
      }
      const specs = tools.size ? [...tools.values()].map((t) => t.spec) : undefined;
      const maxSteps = Math.max(1, options.maxSteps ?? 5);
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
      // Once a tool has run, falling back to another model would run it again.
      let toolsRan = false;

      return withFallback(targets, async (target) => {
        const total = { inputTokens: 0, outputTokens: 0 };
        const steps: Step[] = [];
        const convo = messages.map((m) => ({ ...m }));
        let repairsLeft = schema ? Math.max(0, options.repairAttempts ?? 1) : 0;
        let toolRounds = 0;
        let lastIssues = "";
        const usageNow = (): Usage => ({ requested, model: target.id, ...total, cost: cost(target.id, total), for: options.for, kind: "generate", durationMs: Date.now() - started });
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
              const tool = tools.get(call.name);
              let result: { status: number; output: unknown; text: string };
              if (!tool) {
                const text = `Unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(", ")}.`;
                result = { status: 404, output: text, text };
              } else if (typeof call.input !== "object" || call.input === null || Array.isArray(call.input)) {
                const text = "Tool arguments must be a JSON object.";
                result = { status: 422, output: text, text };
              } else {
                toolsRan = true;
                if (tool.fn) {
                  try {
                    result = await runFunctionTool(tool.fn, call.input, options.signal);
                  } catch (error) {
                    await record(usageNow());
                    throw error;
                  }
                } else result = await tooling!.runner(tool.route!, call.input);
              }
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
            const result = schema.safeParse(parsed);
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
