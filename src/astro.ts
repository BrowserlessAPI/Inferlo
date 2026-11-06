/**
 * Inferlo inside Astro (5 and newer) endpoints, without a runtime dependency on Astro:
 *
 *   // src/pages/api/[...path].ts
 *   import { toAstroHandler } from "@browserlessapi/inferlo/astro";
 *   import { app } from "../../lib/inferlo.ts";
 *
 *   export const prerender = false;
 *   export const ALL = toAstroHandler(app, { prefix: "/api" });
 *
 *   // src/middleware.ts: Astro.locals.ai in pages and context.locals.ai in endpoints and actions
 *   import { inferloAI } from "@browserlessapi/inferlo/astro";
 *   export const onRequest = inferloAI(ai);
 *
 * It never loads the router, database or jobs code.
 */
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";
import type { App as InferloApp } from "./app.ts";
import { clientIps } from "./client-ip.ts";
import { InferloError } from "./errors.ts";
import { normalizePrefix, stripPrefix } from "./serve.ts";

declare global {
  // Astro's app-wide types (src/env.d.ts declares the same namespace; the interfaces merge).
  namespace App {
    interface Locals {
      /** The AI client from the inferloAI() middleware of @browserlessapi/inferlo/astro (or the SvelteKit hook). */
      ai: AI;
    }
  }
}

/** The parts of an Astro APIContext Inferlo uses. */
export interface AstroContextLike {
  /** The incoming Web request. */
  request: Request;
  /** The client IP from the adapter. Astro throws when reading it on prerendered routes; that is ignored. */
  readonly clientAddress?: string;
  /** context.locals, where the inferloAI() middleware puts ai. */
  locals: object;
}

/** An Astro endpoint handler, to export as ALL (or GET, POST...) from a file in src/pages. */
export type AstroHandler = (context: AstroContextLike) => Promise<Response>;

export interface AstroHandlerOptions {
  /**
   * The URL path of the endpoint's folder, removed before the app routes the request: "/api" for
   * src/pages/api/[...path].ts. Requests outside it keep their path. Include Astro's base if set.
   */
  prefix?: string;
}

/** An Astro middleware: export const onRequest = inferloAI(ai), or sequence(inferloAI(ai), ...) to combine it. */
export type AstroMiddleware = (context: { locals: object }, next: () => Promise<Response>) => Promise<Response>;

const fix = 'Pass the app from createApp and the endpoint folder\'s path: export const ALL = toAstroHandler(app, { prefix: "/api" }) in src/pages/api/[...path].ts.';

/**
 * An endpoint handler that runs a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from an
 * Astro catch-all endpoint: export const ALL = toAstroHandler(app, { prefix: "/api" }) in src/pages/api/[...path].ts,
 * with export const prerender = false unless the project uses output: "server".
 */
export function toAstroHandler(app: Pick<InferloApp<any>, "fetch">, options: AstroHandlerOptions = {}): AstroHandler {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5028", "toAstroHandler() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (options === null || typeof options !== "object" || (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/")))) {
    throw new InferloError("IL5028", 'toAstroHandler() prefix must be a path that starts with /, such as "/api".', { fix });
  }
  const prefix = normalizePrefix(options.prefix);

  return async (context) => {
    const incoming = (context as AstroContextLike | undefined)?.request;
    if (!(incoming instanceof Request)) {
      throw new InferloError("IL5028", "toAstroHandler()'s handler was called with something that is not an Astro API context.", {
        fix: 'Export it from an endpoint file in src/pages so Astro calls it: export const ALL = toAstroHandler(app, { prefix: "/api" }).',
      });
    }
    let request = incoming;
    if (prefix) {
      const url = new URL(incoming.url);
      const stripped = stripPrefix(url.pathname, prefix);
      if (stripped !== null) {
        url.pathname = stripped;
        const hasBody = incoming.body !== null && incoming.method !== "GET" && incoming.method !== "HEAD";
        const init: RequestInit & { duplex?: "half" } = {
          method: incoming.method,
          headers: incoming.headers,
          body: hasBody ? incoming.body : undefined,
          signal: incoming.signal,
          redirect: incoming.redirect,
        };
        if (hasBody) init.duplex = "half";
        request = new Request(url, init);
      }
    }
    try {
      const ip = context.clientAddress;
      if (typeof ip === "string" && ip) clientIps.set(request, ip);
    } catch {
      // Astro cannot tell the client address on prerendered routes, and some adapters have none.
    }
    return (app as Pick<InferloApp<any>, "fetch">).fetch(request);
  };
}

/**
 * An Astro middleware that puts an AI client (createAI(...) or an Inferlo app's app.ai) on every request as
 * context.locals.ai (Astro.locals.ai in pages), for pages, endpoints and actions: export const onRequest =
 * inferloAI(ai) in src/middleware.ts, or sequence(inferloAI(ai), yourMiddleware).
 */
export function inferloAI(ai: AI): AstroMiddleware {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: export const onRequest = inferloAI(ai).');
  return (context, next) => {
    (context.locals as { ai?: AI }).ai = ai;
    return next();
  };
}
