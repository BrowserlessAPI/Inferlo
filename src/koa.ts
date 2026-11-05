/**
 * Inferlo inside Koa (2 and 3), without a runtime dependency on Koa:
 *
 *   import Koa from "koa";
 *   import { createAI, anthropic } from "@browserlessapi/inferlo/ai";
 *   import { inferloAI, sendResponse, toKoaMiddleware } from "@browserlessapi/inferlo/koa";
 *
 *   const koa = new Koa();
 *   koa.use(inferloAI(ai));                                       // ctx.ai in every middleware
 *   koa.use(toKoaMiddleware(inferloApp, { prefix: "/api" }));     // or a whole Inferlo app under a path
 *   // stream AI text: sendResponse(ctx, ctx.ai.stream({ model: "fast", prompt }).toResponse())
 *
 * Importing this entry point adds `ai` to Koa's context type. It never loads the router, database or jobs code.
 */
import type { AI } from "./ai/index.ts";
import type { App } from "./app.ts";
import { assertAIClient } from "./ai-client.ts";
import { toNodeHandler, writeResponse, type NodeHandlerOptions, type NodeRequest, type NodeResponse } from "./serve.ts";

// Koa's types come from @types/koa, which TypeScript Koa apps install.
import type {} from "koa";

declare module "koa" {
  interface DefaultContext {
    /** The AI client set by inferloAI() from @browserlessapi/inferlo/koa. */
    ai: AI;
  }
}

/** The parts of a Koa context that this entry point uses. */
export interface KoaContextLike {
  ai?: AI;
  req: NodeRequest & { readableEnded?: boolean };
  res: NodeResponse;
  method: string;
  respond?: boolean;
  /** Koa's request; a body parser puts the parsed body on request.body. */
  request: object;
}

/** A Koa middleware: koa.use(...). */
export type KoaMiddleware = (ctx: KoaContextLike, next: () => Promise<unknown>) => Promise<void>;

/** Puts an AI client (createAI(...) or an Inferlo app's app.ai) on every Koa context as ctx.ai. */
export function inferloAI(ai: AI): KoaMiddleware {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: koa.use(inferloAI(ai)).');
  return async (ctx, next) => {
    ctx.ai = ai;
    await next();
  };
}

/**
 * Runs a whole Inferlo app (routes, auth, validation, OpenAPI and MCP) as Koa middleware. With prefix, only
 * requests under it reach the app (the prefix is removed before routing) and the rest go to the next
 * middleware. With fallthrough: true, requests the app has no route for go to the next middleware too.
 * A body that a body parser already read (ctx.request.body) is used instead of the request stream.
 */
export function toKoaMiddleware(app: Pick<App<any>, "fetch">, options: NodeHandlerOptions = {}): KoaMiddleware {
  const handler = toNodeHandler(app, options);
  return async (ctx, next) => {
    let passed = false;
    const req = ctx.req as NodeRequest & { readableEnded?: boolean };
    // koa-bodyparser and @koa/bodyparser read the stream and keep the result on ctx.request.body.
    const parsed = (ctx.request as { body?: unknown }).body;
    if (req.body === undefined && req.readableEnded && parsed !== undefined) req.body = parsed;
    await handler(req, ctx.res, () => {
      passed = true;
    });
    if (passed) {
      await next();
      return;
    }
    // Inferlo wrote the response itself.
    ctx.respond = false;
  };
}

/**
 * Send a Web Response from a Koa middleware: status, headers (every Set-Cookie) and the body, streamed. Use it
 * for AI streams: await sendResponse(ctx, ctx.ai.stream({ model: "fast", prompt }).toResponse()).
 */
export async function sendResponse(ctx: Pick<KoaContextLike, "res" | "method" | "respond">, response: Response): Promise<void> {
  ctx.respond = false;
  await writeResponse(ctx.res, response, ctx.method);
}
