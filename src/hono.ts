/**
 * Inferlo inside Hono (4.0 and later), without a runtime dependency on Hono:
 *
 *   import { Hono } from "hono";
 *   import { createAI, anthropic } from "@browserlessapi/inferlo/ai";
 *   import { inferloAI, type InferloVariables } from "@browserlessapi/inferlo/hono";
 *
 *   const hono = new Hono<{ Variables: InferloVariables }>();
 *   hono.use(inferloAI(ai));                          // c.var.ai in every handler
 *   hono.mount("/api", inferloApp.fetch);             // or a whole Inferlo app under a path
 *
 * This entry point never loads the router, database or jobs code.
 */
import type { AI } from "./ai/index.ts";
import { InferloError } from "./errors.ts";

/** Context variables set by inferloAI(): new Hono<{ Variables: InferloVariables }>(). */
export type InferloVariables = { ai: AI };

/** The part of Hono's Context that inferloAI() uses. */
export interface HonoContextLike {
  set(key: "ai", value: AI): void;
}

/** A Hono middleware: hono.use(inferloAI(ai)) or hono.use("/chat/*", inferloAI(ai)). */
export type InferloAIMiddleware = (c: HonoContextLike, next: () => Promise<void>) => Promise<void>;

/** Puts an AI client (createAI(...) or an Inferlo app's app.ai) on the Hono context as c.var.ai. */
export function inferloAI(ai: AI): InferloAIMiddleware {
  const candidate = ai as Partial<AI> | undefined;
  if (!candidate || typeof candidate.generate !== "function" || typeof candidate.stream !== "function" || typeof candidate.embed !== "function") {
    throw new InferloError("IL5014", "inferloAI() needs an AI client.", {
      fix: 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: hono.use(inferloAI(ai)).',
    });
  }
  return async (c, next) => {
    c.set("ai", ai);
    await next();
  };
}
