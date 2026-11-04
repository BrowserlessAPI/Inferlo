/**
 * Inferlo inside ElysiaJS (1.0 and later), without a runtime dependency on Elysia:
 *
 *   import { Elysia } from "elysia";
 *   import { createAI, anthropic } from "@browserlessapi/inferlo/ai";
 *   import { inferloAI } from "@browserlessapi/inferlo/elysia";
 *
 *   const server = new Elysia()
 *     .use(inferloAI(ai))                               // ({ ai }) in every handler, typed
 *     .mount("/api", inferloApp.fetch);                 // or a whole Inferlo app under a path
 *
 * This entry point never loads the router, database or jobs code.
 */
import type { Elysia } from "elysia";
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";

/**
 * An Elysia plugin that decorates the context with an AI client (createAI(...) or an Inferlo app's app.ai):
 * new Elysia().use(inferloAI(ai)).post("/classify", ({ ai, body }) => ...).
 */
export function inferloAI(ai: AI) {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: new Elysia().use(inferloAI(ai)).');
  return (app: Elysia) => app.decorate("ai", ai);
}
