/**
 * Tools made from plain functions, for ai.generate({ tools }) anywhere (createAI or ctx.ai):
 *
 *   export const getWeather = tool("getWeather", {
 *     description: "Current weather for a city",
 *     input: t.object({ city: t.string() }),
 *   }).handle(async ({ input }) => fetchWeather(input.city))
 *
 * The model's arguments are validated against input before the function runs.
 */
import { InferloError } from "../errors.ts";
import { ObjectSchema, ValidationError, type Infer, type Shape } from "../schema.ts";
import type { ToolSpec } from "./providers.ts";

export interface FunctionToolOptions<I extends ObjectSchema<Shape>> {
  /** What the tool does and when to use it. The model reads this to decide when to call it. */
  description: string;
  /** Schema of the arguments, a t.object({ ... }). The model's arguments are validated against it. */
  input: I;
}

export interface ToolContext<Input> {
  /** The model's arguments, validated and with defaults applied. */
  input: Input;
  /** The ai.generate call's signal, if it had one. */
  signal?: AbortSignal;
}

/** A tool made with tool(name, options).handle(fn). */
export interface ToolDef<Input = any> {
  readonly kind: "inferlo.tool";
  readonly name: string;
  readonly description: string;
  readonly input: ObjectSchema<Shape>;
  readonly handler: (ctx: ToolContext<Input>) => unknown;
}

export class ToolBuilder<I extends ObjectSchema<Shape>> {
  readonly name: string;
  readonly options: FunctionToolOptions<I>;

  constructor(name: string, options: FunctionToolOptions<I>) {
    this.name = name;
    this.options = options;
  }

  /**
   * The tool's work. Return any JSON value (or a string) for the model. Throw httpError(404, "...")
   * to send a failed tool result to the model; any other error rejects ai.generate.
   */
  handle(handler: (ctx: ToolContext<Infer<I>>) => unknown): ToolDef<Infer<I>> {
    if (typeof handler !== "function") throw invalid(this.name, ["handle() needs a function"]);
    return { kind: "inferlo.tool", name: this.name, description: this.options.description, input: this.options.input, handler: handler as ToolDef["handler"] };
  }
}

/** Provider limit for tool names (Anthropic, OpenAI and Gemini). */
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Define a tool the model can call: tool("getWeather", { description, input: t.object({ ... }) }).handle(fn). */
export function tool<I extends ObjectSchema<Shape>>(name: string, options: FunctionToolOptions<I>): ToolBuilder<I> {
  const problems: string[] = [];
  if (typeof name !== "string" || !TOOL_NAME.test(name)) problems.push("the name must be letters, digits, _ and -, starting with a letter, at most 64 characters");
  if (!options || typeof options !== "object") problems.push("options must be an object with a description and an input schema");
  else {
    if (typeof options.description !== "string" || !options.description.trim()) problems.push("description must say what the tool does");
    if (!(options.input instanceof ObjectSchema)) problems.push("input must be a t.object({ ... }) schema");
  }
  if (problems.length) throw invalid(name, problems);
  return new ToolBuilder(name, options);
}

function invalid(name: unknown, problems: string[]): InferloError {
  return new InferloError("IL5013", `Invalid tool "${String(name)}": ${problems.join(", ")}.`, {
    fix: 'Use tool("getWeather", { description: "Current weather for a city", input: t.object({ city: t.string() }) }).handle(async ({ input }) => { ... }).',
  });
}

export function isTool(value: unknown): value is ToolDef {
  return typeof value === "object" && value !== null && (value as ToolDef).kind === "inferlo.tool";
}

/** What the model is offered for a function tool. Internal. */
export function functionToolSpec(def: ToolDef): ToolSpec {
  return { name: def.name, description: def.description, inputSchema: def.input.toJSONSchema() };
}

/**
 * Runs one call of a function tool. Validation errors and InferloErrors with a status below 500
 * (httpError, notFound, forbidden) become failed tool results for the model; other errors are rethrown.
 * Internal.
 */
export async function runFunctionTool(def: ToolDef, input: unknown, signal: AbortSignal | undefined): Promise<{ status: number; output: unknown; text: string }> {
  try {
    const parsed = def.input.safeParse(input);
    if (!parsed.ok) throw new ValidationError(parsed.issues, "tool input");
    const output = await def.handler({ input: parsed.value, ...(signal ? { signal } : {}) });
    if (typeof output === "string") return { status: 200, output, text: output };
    const text = JSON.stringify(output ?? null);
    return { status: 200, output: output ?? null, text };
  } catch (error) {
    if (error instanceof InferloError && error.status < 500) {
      const output = error.toJSON();
      return { status: error.status, output, text: JSON.stringify(output) };
    }
    throw error;
  }
}
