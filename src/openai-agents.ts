/**
 * OpenAI Agents SDK: Inferlo's AI aliases as an Agents SDK model, and Inferlo tools (function tools and routes)
 * as Agents SDK tools.
 *
 *   import { Agent, run } from "@openai/agents";
 *   import { toOpenAIAgentsModel, toOpenAIAgentsTools } from "@browserlessapi/inferlo/openai-agents";
 *
 *   const agent = new Agent({
 *     name: "Support",
 *     instructions: "Answer support questions.",
 *     model: toOpenAIAgentsModel(ctx.ai, { model: "fast", for: user.id }),
 *     tools: toOpenAIAgentsTools([getWeather, createTicket], { ai: ctx.ai }),
 *   });
 *   const result = await run(agent, body.question);
 *
 * Every model call of the agent goes through Inferlo's AI client, so it keeps Inferlo's aliases, fallback across
 * providers, budgets, usage tracking and tracing; the Agents SDK runs the agent loop, handoffs and guardrails.
 * Needs @openai/agents-core 0.20 or later (installed with @openai/agents; an optional peer dependency).
 */
import { Usage, tool as agentsTool, type FunctionTool, type Model, type ModelRequest, type ModelResponse, type StreamEvent } from "@openai/agents-core";
import { callModel, extractJson, routeToolsOf, type AI } from "./ai/index.ts";
import type { Image, Message, ToolSpec } from "./ai/providers.ts";
import { functionToolSpec, isTool, runFunctionTool, type ToolDef } from "./ai/tool.ts";
import { InferloError } from "./errors.ts";
import type { RouteDef } from "./route.ts";

export interface OpenAIAgentsModelOptions {
  /** Alias ("fast") or "provider:model". Default: the AI's default model. */
  model?: string;
  /** Who the calls are for (user or tenant id), for usage tracking and budgets. */
  for?: string;
}

const invalid = (message: string, fix: string) => new InferloError("IL5033", message, { fix });

type Item = Record<string, any>;

/** Text of a message content (a string or a list of parts) and its images. */
function contentOf(content: unknown): { text: string; images: Image[] } {
  if (typeof content === "string") return { text: content, images: [] };
  const images: Image[] = [];
  let text = "";
  for (const part of Array.isArray(content) ? (content as Item[]) : []) {
    if (!part || typeof part !== "object") continue;
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") text += part.text;
    else if (part.type === "refusal" && typeof part.refusal === "string") text += part.refusal;
    else if (part.type === "input_image") {
      const image = typeof part.image === "string" ? part.image : typeof part.imageUrl === "string" ? part.imageUrl : undefined;
      if (!image) continue;
      const data = /^data:([^;,]+);base64,(.*)$/s.exec(image);
      images.push(data ? { base64: data[2]!, mediaType: data[1] as never } : { url: image });
    }
  }
  return { text, images };
}

/** A tool result's output as text. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(outputText).join("");
  if (output && typeof output === "object") {
    const o = output as Item;
    if (typeof o.text === "string") return o.text;
    return JSON.stringify(o);
  }
  return String(output ?? "");
}

/** The Agents SDK's input items as Inferlo messages. Consecutive function calls belong to one assistant turn. */
export function agentInputToMessages(input: ModelRequest["input"], systemInstructions?: string): Message[] {
  const messages: Message[] = systemInstructions ? [{ role: "system", content: systemInstructions }] : [];
  const items: Item[] = typeof input === "string" ? [{ role: "user", content: input }] : (input as Item[]);
  for (const item of items) {
    const type = item.type ?? "message";
    if (type === "message") {
      const { text, images } = contentOf(item.content);
      if (item.role === "system" || item.role === "developer") messages.push({ role: "system", content: text });
      else if (item.role === "user") messages.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
      else if (item.role === "assistant") messages.push({ role: "assistant", content: text });
    } else if (type === "function_call") {
      let parsed: unknown = {};
      try {
        parsed = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        parsed = {};
      }
      const call = { id: String(item.callId), name: String(item.name), input: parsed };
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") last.toolCalls = [...(last.toolCalls ?? []), call];
      else messages.push({ role: "assistant", content: "", toolCalls: [call] });
    } else if (type === "function_call_result") {
      messages.push({ role: "tool", content: outputText(item.output), toolCallId: String(item.callId) });
    }
    // Reasoning items, hosted tool calls and other provider-specific items have no Inferlo counterpart: skipped.
  }
  return messages;
}

/** The function tools and handoffs the agent offers, as Inferlo tool specs. Hosted tools cannot run through Inferlo. */
function toolSpecs(request: ModelRequest): ToolSpec[] | undefined {
  const specs: ToolSpec[] = [];
  for (const t of request.tools ?? []) {
    if (t.type !== "function") {
      throw invalid(`The agent uses the hosted tool "${(t as { name?: string }).name ?? t.type}", which only OpenAI's own models run.`, "Use function tools (tool() from @openai/agents, or toOpenAIAgentsTools()) with toOpenAIAgentsModel(), or give this agent an OpenAI model.");
    }
    specs.push({ name: t.name, description: t.description ?? "", inputSchema: t.parameters as Record<string, unknown> });
  }
  for (const h of request.handoffs ?? []) specs.push({ name: h.toolName, description: h.toolDescription ?? "", inputSchema: (h.inputJsonSchema as Record<string, unknown>) ?? { type: "object", properties: {} } });
  return specs.length ? specs : undefined;
}

/** Inferlo's AI client as an Agents SDK Model. Make one with toOpenAIAgentsModel(ai, { model }). */
export class InferloAgentsModel implements Model {
  readonly ai: AI;
  readonly options: OpenAIAgentsModelOptions;

  constructor(ai: AI, options: OpenAIAgentsModelOptions = {}) {
    this.ai = ai;
    this.options = options;
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const messages = agentInputToMessages(request.input, request.systemInstructions);
    const output = request.outputType;
    const schema = output && typeof output === "object" && output.type === "json_schema" ? output.schema : undefined;
    if (schema) {
      const instruction = "When you give your final answer, respond with only a JSON value that matches this JSON Schema. No prose, no code fences.\n" + JSON.stringify(schema);
      const sys = messages.find((m) => m.role === "system");
      if (sys) sys.content += "\n\n" + instruction;
      else messages.unshift({ role: "system", content: instruction });
    }
    const settings = request.modelSettings ?? {};
    const result = await callModel(this.ai, {
      model: this.options.model,
      messages,
      tools: toolSpecs(request),
      ...(typeof settings.temperature === "number" ? { temperature: settings.temperature } : {}),
      ...(typeof settings.maxTokens === "number" ? { maxTokens: settings.maxTokens } : {}),
      for: this.options.for,
      signal: request.signal,
    });
    let text = result.text;
    // The SDK parses a structured final answer itself: give it the JSON without fences or prose around it.
    if (schema && !result.toolCalls.length) {
      try {
        text = JSON.stringify(extractJson(text));
      } catch {
        // Left as it is; the SDK reports that the output does not match.
      }
    }
    const items: ModelResponse["output"] = [];
    if (text || !result.toolCalls.length) items.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
    for (const call of result.toolCalls) {
      items.push({ type: "function_call", callId: call.id, name: call.name, arguments: JSON.stringify(call.input ?? {}), status: "completed" });
    }
    return {
      usage: new Usage({ requests: 1, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.inputTokens + result.usage.outputTokens }),
      output: items,
      responseId: `inferlo-${crypto.randomUUID()}`,
      providerData: { model: result.usage.model, requested: result.usage.requested, cost: result.usage.cost },
    };
  }

  /** The answer as one text delta and a response_done event (Inferlo returns tool calls with the whole answer). */
  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const response = await this.getResponse(request);
    yield { type: "response_started" };
    for (const item of response.output) {
      if (item.type === "message") {
        const text = contentOf((item as Item).content).text;
        if (text) yield { type: "output_text_delta", delta: text };
      }
    }
    yield {
      type: "response_done",
      response: {
        id: response.responseId!,
        usage: { requests: 1, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, totalTokens: response.usage.totalTokens },
        output: response.output as never,
      },
    };
  }
}

/**
 * An Agents SDK model that calls Inferlo's AI: toOpenAIAgentsModel(ctx.ai, { model: "fast", for: user.id }). Pass it
 * as an Agent's model (new Agent({ model })); the agent then gets Inferlo's aliases, fallback, budgets and usage.
 */
export function toOpenAIAgentsModel(ai: AI, options: OpenAIAgentsModelOptions = {}): InferloAgentsModel {
  if (!ai || typeof ai !== "object" || typeof (ai as AI).generate !== "function") {
    throw invalid("toOpenAIAgentsModel(ai) needs Inferlo's AI client.", 'Pass ctx.ai in a route handler or job, app.ai, or the client createAI() returns: toOpenAIAgentsModel(ctx.ai, { model: "fast" }).');
  }
  if (options === null || typeof options !== "object") throw invalid("toOpenAIAgentsModel() options must be an object.", 'Use toOpenAIAgentsModel(ai, { model: "fast" }).');
  for (const key of Object.keys(options)) {
    if (key !== "model" && key !== "for") throw invalid(`Unknown toOpenAIAgentsModel() option "${key}".`, 'Options: model and for. Set temperature and maxTokens with the Agent\'s modelSettings.');
  }
  return new InferloAgentsModel(ai, { ...options });
}

/**
 * Inferlo tools as Agents SDK function tools. Function tools (tool(name, ...).handle(fn)) work anywhere; routes work
 * with a request's AI client ({ ai: ctx.ai }) and run as the signed-in user, with the route's auth and validation.
 */
export function toOpenAIAgentsTools(tools: readonly (ToolDef | RouteDef)[], options: { ai?: AI } = {}): FunctionTool[] {
  if (!Array.isArray(tools)) throw invalid("toOpenAIAgentsTools() needs an array of tools.", "Pass [getWeather, createTicket]: function tools and routes.");
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
        throw new InferloError("IL5009", "Routes as Agents SDK tools need the AI client of a request.", {
          fix: "Call toOpenAIAgentsTools([createTicket], { ai: ctx.ai }) in a route handler, so each route runs as the signed-in user with its auth and validation, or make a function tool with tool(name, { description, input }).handle(fn).",
        });
      }
      const route = entry as RouteDef;
      spec = routeTools.describe(route);
      run = async (input) => (await routeTools.runner(route, input)).text;
    } else {
      throw invalid("toOpenAIAgentsTools() takes function tools made with tool(...).handle(fn) and routes.", "Pass [getWeather, createTicket].");
    }
    if (names.has(spec.name)) throw new InferloError("IL5013", `Two tools are named "${spec.name}".`, { fix: "Give each tool a unique name (a route's tool name is its export name, or tool: { name })." });
    names.add(spec.name);
    // Not strict: Inferlo validates the input itself (and answers the model with the problems), so optional fields stay optional.
    return agentsTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema as never,
      strict: false,
      execute: async (input: unknown) => run(typeof input === "string" ? JSON.parse(input || "{}") : input),
    }) as FunctionTool;
  });
}
