/**
 * Inferlo inside hapi (21 and later), without a runtime dependency on hapi:
 *
 *   import Hapi from "@hapi/hapi";
 *   import { createAI, anthropic } from "@browserlessapi/inferlo/ai";
 *   import { inferloPlugin } from "@browserlessapi/inferlo/hapi";
 *
 *   const server = Hapi.server({ port: 3000 });
 *   await server.register({ plugin: inferloPlugin, options: { ai } });                                // server.ai and request.ai
 *   await server.register({ plugin: inferloPlugin, options: { app: inferloApp }, routes: { prefix: "/api" } }); // a whole Inferlo app under /api
 *
 * Importing this entry point adds `ai` to hapi's server and request types. It never loads the router,
 * database or jobs code.
 */
import type { Plugin, Request as HapiRequest, ResponseToolkit, Server } from "@hapi/hapi";
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";
import { InferloError } from "./errors.ts";
import { toNodeHandler, type NodeRequest, type NodeResponse } from "./serve.ts";

declare module "@hapi/hapi" {
  interface Server {
    /** The AI client registered with inferloPlugin from @browserlessapi/inferlo/hapi. */
    ai: AI;
  }
  interface Request {
    /** The AI client registered with inferloPlugin from @browserlessapi/inferlo/hapi. */
    ai: AI;
  }
}

export interface InferloPluginOptions {
  /** AI client for server.ai and request.ai: createAI(...) or an Inferlo app's app.ai. Default: app.ai, unless server.ai is already set. */
  ai?: AI;
  /**
   * A whole Inferlo app (routes, auth, validation, OpenAPI, MCP) to serve. It is served under the prefix you
   * register the plugin with (routes: { prefix: "/api" }), or, without one, for every path hapi has no route for.
   */
  app?: { fetch(req: Request, ...rest: unknown[]): Promise<Response>; ai?: AI };
}

/** A hapi plugin, registered with server.register({ plugin: inferloPlugin, options }). */
export type InferloPlugin = Plugin<InferloPluginOptions>;

const bad = (message: string, fix: string) => new InferloError("IL5025", message, { fix });

async function register(server: Server, options: InferloPluginOptions): Promise<void> {
  if (options === null || typeof options !== "object") {
    throw bad("inferloPlugin options must be an object with ai, app or both.", "Use server.register({ plugin: inferloPlugin, options: { ai } }).");
  }
  if ("prefix" in options) {
    throw bad("inferloPlugin takes the path prefix from hapi, not from its options.", 'Use server.register({ plugin: inferloPlugin, options: { app }, routes: { prefix: "/api" } }).');
  }
  const { app } = options;
  if (app !== undefined && (typeof app !== "object" || app === null || typeof app.fetch !== "function")) {
    throw bad("inferloPlugin's app must be an Inferlo app (createApp(...)).", 'Use server.register({ plugin: inferloPlugin, options: { app: inferloApp }, routes: { prefix: "/api" } }).');
  }
  if (!app && !options.ai) {
    throw bad("inferloPlugin needs ai, app or both.", 'Use options: { ai } for server.ai and request.ai, or options: { app } with routes: { prefix: "/api" } to serve an Inferlo app.');
  }
  const decorated = server.decorations.server.includes("ai");
  // app.ai is the default, unless an earlier registration with { ai } already set server.ai.
  const ai = options.ai ?? (decorated ? undefined : app?.ai);
  if (ai !== undefined) {
    assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: server.register({ plugin: inferloPlugin, options: { ai } }).');
    if (decorated) {
      throw bad("server.ai is already set by an earlier inferloPlugin registration.", "Register inferloPlugin with { ai } once, and with { app } (without ai) for each app you serve.");
    }
    // A value, not a method (older hapi types only describe method decorations).
    server.decorate("server", "ai", ai as never);
    // A getter, so every request reads the one client.
    server.decorate("request", "ai", () => ai, { apply: true });
  }
  if (!app) return;
  const prefix = server.realm.modifiers.route.prefix;
  const handler = toNodeHandler(app, { prefix });
  // Inferlo reads the body stream itself (JSON, forms, its own size limits) and writes the answer, streams
  // included, to the Node response; hapi's own routes stay more specific than this catch-all.
  server.route({
    method: "*",
    path: "/{path*}",
    options: { payload: { output: "stream", parse: false }, description: "Inferlo app" },
    handler: async (request: HapiRequest, h: ResponseToolkit) => {
      await handler(request.raw.req as NodeRequest, request.raw.res as unknown as NodeResponse);
      return h.abandon;
    },
  });
}

/**
 * hapi plugin. options: { ai } decorates server.ai and request.ai; options: { app } serves a whole Inferlo app
 * (routes, auth, validation, OpenAPI, MCP) under the prefix the plugin is registered with (routes: { prefix }).
 */
export const inferloPlugin: InferloPlugin = {
  name: "@browserlessapi/inferlo",
  multiple: true,
  register,
};
