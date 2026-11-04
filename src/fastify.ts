/**
 * Inferlo inside Fastify (5 and later), without a runtime dependency on Fastify:
 *
 *   import Fastify from "fastify";
 *   import { createAI, anthropic } from "@browserlessapi/inferlo/ai";
 *   import { inferloPlugin } from "@browserlessapi/inferlo/fastify";
 *
 *   const fastify = Fastify();
 *   await fastify.register(inferloPlugin, { ai });                         // fastify.ai and request.ai
 *   await fastify.register(inferloPlugin, { app: inferloApp, prefix: "/api" }); // or a whole Inferlo app under /api
 *
 * Importing this entry point adds `ai` to Fastify's instance and request types. It never loads the router,
 * database or jobs code.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";
import { InferloError } from "./errors.ts";
import { toNodeHandler, type NodeRequest, type NodeResponse } from "./serve.ts";

declare module "fastify" {
  interface FastifyInstance {
    /** The AI client registered with inferloPlugin from @browserlessapi/inferlo/fastify. */
    ai: AI;
  }
  interface FastifyRequest {
    /** The AI client registered with inferloPlugin from @browserlessapi/inferlo/fastify. */
    ai: AI;
  }
}

export interface InferloPluginOptions {
  /** AI client for fastify.ai and request.ai: createAI(...) or an Inferlo app's app.ai. Default: app.ai, unless fastify.ai is already set. */
  ai?: AI;
  /** A whole Inferlo app (routes, auth, OpenAPI, MCP) to serve under prefix. */
  app?: { fetch(req: Request, ...rest: unknown[]): Promise<Response>; ai?: AI };
  /** Path the app is served under, for example "/api". Required with app. */
  prefix?: string;
}

/** A Fastify plugin, registered with fastify.register(inferloPlugin, options). */
export type InferloPlugin = FastifyPluginAsync<InferloPluginOptions>;

const bad = (message: string, fix: string) => new InferloError("IL5015", message, { fix });

async function plugin(fastify: FastifyInstance, options: InferloPluginOptions): Promise<void> {
  const { app, prefix } = options ?? {};
  if (app !== undefined && (typeof app !== "object" || app === null || typeof app.fetch !== "function")) {
    throw bad("inferloPlugin's app must be an Inferlo app (createApp(...)).", 'Use fastify.register(inferloPlugin, { app: inferloApp, prefix: "/api" }).');
  }
  // app.ai is the default, unless an earlier register(inferloPlugin, { ai }) already set fastify.ai.
  const ai = options?.ai ?? (fastify.hasDecorator("ai") ? undefined : app?.ai);
  if (!app && !options?.ai) throw bad("inferloPlugin needs ai, app or both.", 'Use fastify.register(inferloPlugin, { ai }) for fastify.ai and request.ai, or { app, prefix: "/api" } to serve an Inferlo app.');
  if (ai !== undefined) {
    assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: fastify.register(inferloPlugin, { ai }).');
    fastify.decorate("ai", ai);
    fastify.decorateRequest("ai", { getter: () => ai });
  }
  if (!app) return;
  if (typeof prefix !== "string" || !/^\/[^*?#]*[^/*?#]$/.test(prefix)) {
    throw bad(`inferloPlugin needs a prefix such as "/api" to serve an app, got ${JSON.stringify(prefix)}.`, 'Use fastify.register(inferloPlugin, { app, prefix: "/api" }).');
  }
  const handler = toNodeHandler(app, { prefix });
  // In a child context, so the catch-all body parser applies to the app's routes only: Inferlo reads the
  // body stream itself (JSON, forms, any size limit), and Fastify answers nothing for these paths.
  await fastify.register(async (child) => {
    child.removeAllContentTypeParsers();
    child.addContentTypeParser("*", (_request, _payload, done) => done(null));
    const mount = async (request: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      await handler(request.raw as NodeRequest, reply.raw as NodeResponse);
    };
    child.all(prefix, mount);
    child.all(`${prefix}/*`, mount);
  });
}

/**
 * Fastify plugin. { ai } decorates fastify.ai and request.ai everywhere in the Fastify app; { app, prefix }
 * serves a whole Inferlo app (routes, auth, validation, OpenAPI, MCP) under prefix. Both can be combined.
 */
export const inferloPlugin: InferloPlugin = Object.assign(plugin, {
  // Like fastify-plugin: the decorators are visible to the whole Fastify app, not only inside this plugin.
  [Symbol.for("skip-override")]: true,
  [Symbol.for("fastify.display-name")]: "inferlo",
});
