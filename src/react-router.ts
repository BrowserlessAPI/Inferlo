/**
 * Inferlo inside React Router 7 and 8 (framework mode, formerly Remix) resource routes, without a runtime
 * dependency on React Router:
 *
 *   // app/routes.ts: route("api/*", "routes/api.ts")
 *   // app/routes/api.ts
 *   import { toReactRouterHandlers } from "@browserlessapi/inferlo/react-router";
 *   import { app } from "~/inferlo/app.server";
 *
 *   export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" });
 *
 * GET and HEAD requests reach the loader, POST, PUT, PATCH and DELETE the action; both run the whole Inferlo app.
 * In other loaders and actions, use @browserlessapi/inferlo/ai. It never loads the router, database or jobs code.
 */
import type { App } from "./app.ts";
import { InferloError } from "./errors.ts";
import { normalizePrefix, stripPrefix } from "./serve.ts";

/** The parts of React Router's loader and action arguments Inferlo uses. */
export interface ReactRouterArgsLike {
  /** The incoming Web request. */
  request: Request;
}

/** A React Router loader or action that answers with the Inferlo app's Response. */
export type ReactRouterHandler = (args: ReactRouterArgsLike) => Promise<Response>;

/** The loader and action of a resource route: export const { loader, action } = toReactRouterHandlers(app). */
export interface ReactRouterHandlers {
  /** GET and HEAD requests. */
  loader: ReactRouterHandler;
  /** POST, PUT, PATCH and DELETE requests. */
  action: ReactRouterHandler;
}

export interface ReactRouterHandlersOptions {
  /**
   * The URL path of the splat route, removed before the app routes the request: "/api" for route("api/*", ...).
   * Requests outside it keep their path. Include the app's basename if one is set.
   */
  prefix?: string;
}

const fix = 'Pass the app from createApp and the route\'s path: export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" }).';

/**
 * A loader and an action that run a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP)
 * from a React Router resource route.
 */
export function toReactRouterHandlers(app: Pick<App<any>, "fetch">, options: ReactRouterHandlersOptions = {}): ReactRouterHandlers {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5023", "toReactRouterHandlers() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (options === null || typeof options !== "object" || (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/")))) {
    throw new InferloError("IL5023", 'toReactRouterHandlers() prefix must be a path that starts with /, such as "/api".', { fix });
  }
  const prefix = normalizePrefix(options.prefix);

  const handle: ReactRouterHandler = async (args) => {
    const incoming = (args as ReactRouterArgsLike | undefined)?.request;
    if (!(incoming instanceof Request)) {
      throw new InferloError("IL5023", "toReactRouterHandlers()'s loader and action were called without a request.", {
        fix: 'Export them from a resource route module so React Router calls them: export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" }).',
      });
    }
    const url = new URL(incoming.url);
    const stripped = prefix ? stripPrefix(url.pathname, prefix) : null;
    if (stripped === null) return (app as Pick<App<any>, "fetch">).fetch(incoming);
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
    return (app as Pick<App<any>, "fetch">).fetch(new Request(url, init));
  };

  return Object.freeze({ loader: handle, action: handle });
}
