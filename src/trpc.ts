/**
 * Inferlo inside tRPC (11.0 and later), without a runtime dependency on tRPC:
 *
 *   import { initTRPC } from "@trpc/server";
 *   import { createAI, anthropic, t } from "@browserlessapi/inferlo/ai";
 *   import { inferloAI, trpcTools } from "@browserlessapi/inferlo/trpc";
 *
 *   const trpc = initTRPC.context<Context>().create();
 *   const aiProcedure = trpc.procedure.use(inferloAI(ai));   // ctx.ai in every procedure, typed
 *
 *   export const appRouter = trpc.router({
 *     summarize: aiProcedure.input(t.object({ text: t.string() }))   // Inferlo schemas work as tRPC inputs
 *       .mutation(async ({ ctx, input }) => (await ctx.ai.generate({ model: "fast", prompt: input.text })).text),
 *     chat: aiProcedure.input(t.object({ prompt: t.string() }))
 *       .subscription(async function* ({ ctx, input, signal }) {
 *         yield* ctx.ai.stream({ model: "fast", prompt: input.prompt, signal });   // text chunks
 *       }),
 *   });
 *
 *   // Procedures as AI tools, called as the current user through a caller:
 *   const tools = trpcTools(appRouter, {
 *     caller: appRouter.createCaller(ctx),
 *     procedures: { "tickets.create": "Create a support ticket for the current user." },
 *   });
 *   await ai.generate({ model: "fast", prompt, tools, maxSteps: 5 });
 *
 * This entry point never loads the router, database or jobs code.
 */
import type { MiddlewareFunction } from "@trpc/server/unstable-core-do-not-import";
import type { AI } from "./ai/index.ts";
import { tool, type ToolDef } from "./ai/tool.ts";
import { assertAIClient } from "./ai-client.ts";
import { httpError, InferloError } from "./errors.ts";
import { ObjectSchema, t, type Shape } from "./schema.ts";

/**
 * A tRPC middleware that puts an AI client (createAI(...) or an Inferlo app's app.ai) on the context:
 * const aiProcedure = trpc.procedure.use(inferloAI(ai)), then ctx.ai in its procedures.
 */
export function inferloAI(ai: AI): MiddlewareFunction<any, any, any, { ai: AI }, any> {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: trpc.procedure.use(inferloAI(ai)).');
  return ({ next }) => next({ ctx: { ai } });
}

/** A procedure offered as a tool: its description, or { description, input } for procedures whose input is not a t.object. */
export type TrpcToolProcedure = string | { description: string; input: ObjectSchema<Shape> };

export interface TrpcToolsOptions {
  /** Runs the procedures: appRouter.createCaller(ctx) or createCallerFactory(appRouter)(ctx), with the current user's context. */
  caller: object;
  /** Procedure paths ("tickets.create") and what each does. The model reads the description to decide when to call it. */
  procedures: Record<string, TrpcToolProcedure>;
}

/** The parts of a tRPC router and procedure that trpcTools() reads. */
interface RouterLike {
  _def?: { procedures?: Record<string, { _def?: { type?: string; inputs?: unknown[] } }> };
}

/** HTTP status of each tRPC error code a model can correct (the others reject ai.generate). */
const CLIENT_ERRORS: Record<string, number> = {
  BAD_REQUEST: 400,
  PARSE_ERROR: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_SUPPORTED: 405,
  TIMEOUT: 408,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE_CONTENT: 422,
  TOO_MANY_REQUESTS: 429,
  CLIENT_CLOSED_REQUEST: 499,
};

/**
 * Makes AI tools from tRPC queries and mutations, for ai.generate({ tools }). Each tool is named after its
 * path with "." replaced by "_" ("tickets.create" becomes tickets_create), takes the procedure's t.object input,
 * and runs through the caller, so the procedure's middleware, auth and validation apply. TRPCErrors such as
 * NOT_FOUND or FORBIDDEN go back to the model as failed tool results; server errors reject ai.generate.
 */
export function trpcTools(router: object, options: TrpcToolsOptions): ToolDef[] {
  const problems: string[] = [];
  const procedures = (router as RouterLike | undefined)?._def?.procedures;
  if (!procedures || typeof procedures !== "object") problems.push("the first argument must be a tRPC router (trpc.router({ ... }))");
  if (!options || typeof options !== "object") {
    problems.push("options must be { caller, procedures }");
    throw invalid(problems);
  }
  if (!options.caller || (typeof options.caller !== "object" && typeof options.caller !== "function")) problems.push("caller must be appRouter.createCaller(ctx)");
  const entries = options.procedures && typeof options.procedures === "object" ? Object.entries(options.procedures) : [];
  if (!entries.length) problems.push('procedures must name at least one procedure: { "tickets.create": "Create a support ticket." }');
  if (problems.length) throw invalid(problems);

  const tools: ToolDef[] = [];
  for (const [path, entry] of entries) {
    const procedure = procedures![path];
    if (!procedure) {
      const known = Object.keys(procedures!);
      problems.push(`"${path}" is not a procedure of this router${known.length ? ` (procedures: ${known.join(", ")})` : ""}`);
      continue;
    }
    const type = procedure._def?.type;
    if (type !== "query" && type !== "mutation") {
      problems.push(`"${path}" is a ${type ?? "unknown"} procedure; only queries and mutations can be tools`);
      continue;
    }
    const description = typeof entry === "string" ? entry : entry?.description;
    if (typeof description !== "string" || !description.trim()) {
      problems.push(`"${path}" needs a description of what it does`);
      continue;
    }
    const inputs = procedure._def?.inputs ?? [];
    let input: ObjectSchema<Shape>;
    if (typeof entry === "object" && entry !== null && entry.input !== undefined) {
      if (!(entry.input instanceof ObjectSchema)) {
        problems.push(`"${path}" input must be a t.object({ ... }) schema`);
        continue;
      }
      input = entry.input;
    } else if (inputs.every((parser) => parser instanceof ObjectSchema)) {
      const shape: Shape = {};
      for (const parser of inputs as ObjectSchema<Shape>[]) Object.assign(shape, parser.shape);
      input = t.object(shape);
    } else {
      problems.push(`"${path}" has an input that is not a t.object schema from Inferlo; pass { description, input: t.object({ ... }) } for it`);
      continue;
    }
    const name = path.replace(/\./g, "_");
    const hasInput = inputs.length > 0;
    const call = resolve(options.caller, path);
    try {
      tools.push(
        tool(name, { description, input }).handle(async ({ input: args }) => {
          try {
            return await call(hasInput ? args : undefined);
          } catch (error) {
            throw toToolError(error);
          }
        }),
      );
    } catch (error) {
      if (error instanceof InferloError) problems.push(`"${path}" does not make a valid tool name (${name})`);
      else throw error;
    }
  }
  if (problems.length) throw invalid(problems);
  return tools;
}

/** caller.tickets.create, looked up when the tool runs (callers are proxies). */
function resolve(caller: object, path: string): (input: unknown) => Promise<unknown> {
  return async (input) => {
    let target: any = caller;
    for (const key of path.split(".")) target = target[key];
    return target(input);
  };
}

/** TRPCErrors a model can correct become httpErrors (failed tool results); anything else is rethrown. */
function toToolError(error: unknown): unknown {
  if (error instanceof InferloError) return error;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null;
  if (!candidate || typeof candidate !== "object" || candidate.name !== "TRPCError" || typeof candidate.code !== "string") return error;
  if (candidate.cause instanceof InferloError && candidate.cause.status < 500) return candidate.cause;
  const status = CLIENT_ERRORS[candidate.code];
  if (status === undefined) return error;
  return httpError(status, typeof candidate.message === "string" ? candidate.message : candidate.code, { code: candidate.code });
}

function invalid(problems: string[]): InferloError {
  return new InferloError("IL5017", `Invalid trpcTools() options: ${problems.join("; ")}.`, {
    fix: 'Use trpcTools(appRouter, { caller: appRouter.createCaller(ctx), procedures: { "tickets.create": "Create a support ticket." } }) with queries and mutations whose input is a t.object({ ... }).',
  });
}
