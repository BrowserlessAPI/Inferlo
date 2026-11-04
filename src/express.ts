/**
 * Inferlo inside Express (4 and 5), without a runtime dependency on Express:
 *
 *   import express from "express";
 *   import { createAI, anthropic } from "@browserlessapi/inferlo/ai";
 *   import { toNodeHandler } from "@browserlessapi/inferlo";
 *   import { inferloAI, sendResponse } from "@browserlessapi/inferlo/express";
 *
 *   const server = express();
 *   server.use(inferloAI(ai));                          // req.ai in every handler
 *   server.get("/chat", (req, res) => sendResponse(res, req.ai.stream({ prompt: "Hi" }).toResponse()));
 *   server.use("/api", toNodeHandler(inferloApp));      // or a whole Inferlo app under a path
 *
 * Importing this entry point adds `ai` to Express's Request type. It never loads the router, database or jobs code.
 */
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";
import { writeResponse, type NodeResponse } from "./serve.ts";

declare global {
  // Express's Request type extends Express.Request, so this makes req.ai typed in every handler.
  namespace Express {
    interface Request {
      /** The AI client set by inferloAI() from @browserlessapi/inferlo/express. */
      ai: AI;
    }
  }
}

/** The part of an Express request that inferloAI() uses. */
export interface ExpressRequestLike {
  ai?: AI;
}

/** An Express middleware: server.use(inferloAI(ai)) or server.use("/chat", inferloAI(ai)). */
export type InferloAIMiddleware = (req: ExpressRequestLike, res: unknown, next: (error?: unknown) => void) => void;

/** Puts an AI client (createAI(...) or an Inferlo app's app.ai) on every Express request as req.ai. */
export function inferloAI(ai: AI): InferloAIMiddleware {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: server.use(inferloAI(ai)).');
  return (req, _res, next) => {
    req.ai = ai;
    next();
  };
}

/**
 * Send a Web Response from an Express (or node:http) handler: status, headers (every Set-Cookie) and the
 * body, streamed. Use it for AI streams: sendResponse(res, req.ai.stream({ prompt }).toResponse()).
 */
export function sendResponse(res: NodeResponse, response: Response): Promise<void> {
  return writeResponse(res, response, "GET");
}
