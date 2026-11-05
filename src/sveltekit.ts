/**
 * Inferlo inside SvelteKit (2 and 3) server routes, without a runtime dependency on SvelteKit:
 *
 *   // src/routes/api/[...path]/+server.ts
 *   import { toSvelteKitHandlers } from "@browserlessapi/inferlo/sveltekit";
 *   import { app } from "$lib/server/inferlo";
 *
 *   export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, fallback } = toSvelteKitHandlers(app, { prefix: "/api" });
 *
 *   // src/hooks.server.ts: event.locals.ai in load functions, form actions and +server.ts files
 *   import { inferloAI } from "@browserlessapi/inferlo/sveltekit";
 *   export const handle = inferloAI(ai);
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
  // SvelteKit's app-wide types (src/app.d.ts declares the same namespace; the interfaces merge).
  namespace App {
    interface Locals {
      /** The AI client from the inferloAI() handle hook of @browserlessapi/inferlo/sveltekit. */
      ai: AI;
    }
  }
}

/** The parts of a SvelteKit RequestEvent Inferlo uses. */
export interface SvelteKitEventLike {
  /** The incoming Web request. */
  request: Request;
  /** The client IP from the adapter; called once per request, and errors (some adapters have none) are ignored. */
  getClientAddress?: () => string;
  /** event.locals, where the inferloAI() hook puts ai. */
  locals: object;
}

/** A SvelteKit request handler, to export from a +server.ts file. */
export type SvelteKitRequestHandler = (event: SvelteKitEventLike) => Promise<Response>;

/** One request handler per HTTP method and a fallback for every other method, to export from +server.ts. */
export interface SvelteKitHandlers {
  GET: SvelteKitRequestHandler;
  POST: SvelteKitRequestHandler;
  PUT: SvelteKitRequestHandler;
  PATCH: SvelteKitRequestHandler;
  DELETE: SvelteKitRequestHandler;
  HEAD: SvelteKitRequestHandler;
  OPTIONS: SvelteKitRequestHandler;
  fallback: SvelteKitRequestHandler;
}

export interface SvelteKitHandlersOptions {
  /**
   * The URL path of the route folder, removed before the app routes the request: "/api" for
   * src/routes/api/[...path]/+server.ts. Requests outside it keep their path. Include SvelteKit's paths.base if set.
   */
  prefix?: string;
}

/** A SvelteKit handle hook: export const handle = inferloAI(ai), or sequence(inferloAI(ai), ...) to combine it. */
export type SvelteKitHandle = (input: {
  event: { locals: object };
  resolve: (event: any, opts?: any) => Response | Promise<Response>;
}) => Response | Promise<Response>;

const fix = 'Pass the app from createApp and the route folder\'s path: export const { GET, POST, fallback } = toSvelteKitHandlers(app, { prefix: "/api" }).';

/**
 * Request handlers that run a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from a
 * SvelteKit rest route: export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, fallback } = toSvelteKitHandlers(app).
 */
export function toSvelteKitHandlers(app: Pick<InferloApp<any>, "fetch">, options: SvelteKitHandlersOptions = {}): SvelteKitHandlers {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5022", "toSvelteKitHandlers() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (options === null || typeof options !== "object" || (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/")))) {
    throw new InferloError("IL5022", 'toSvelteKitHandlers() prefix must be a path that starts with /, such as "/api".', { fix });
  }
  const prefix = normalizePrefix(options.prefix);

  const handle: SvelteKitRequestHandler = async (event) => {
    const incoming = (event as SvelteKitEventLike | undefined)?.request;
    if (!(incoming instanceof Request)) {
      throw new InferloError("IL5022", "toSvelteKitHandlers()'s handlers were called with something that is not a SvelteKit request event.", {
        fix: "Export them from a +server.ts file so SvelteKit calls them: export const { GET, POST, fallback } = toSvelteKitHandlers(app, { prefix: \"/api\" }).",
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
      const ip = event.getClientAddress?.();
      if (typeof ip === "string" && ip) clientIps.set(request, ip);
    } catch {
      // The adapter cannot tell the client address (for example while prerendering).
    }
    return (app as Pick<InferloApp<any>, "fetch">).fetch(request);
  };

  return Object.freeze({ GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle, HEAD: handle, OPTIONS: handle, fallback: handle });
}

/**
 * A SvelteKit handle hook that puts an AI client (createAI(...) or an Inferlo app's app.ai) on every request as
 * event.locals.ai, for load functions, form actions and +server.ts files: export const handle = inferloAI(ai) in
 * src/hooks.server.ts, or sequence(inferloAI(ai), yourHandle).
 */
export function inferloAI(ai: AI): SvelteKitHandle {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: export const handle = inferloAI(ai).');
  return ({ event, resolve }) => {
    (event.locals as { ai?: AI }).ai = ai;
    return resolve(event);
  };
}
