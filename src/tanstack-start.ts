/**
 * Inferlo inside TanStack Start server routes, without a runtime dependency on TanStack Start:
 *
 *   // src/routes/api/$.ts
 *   import { createFileRoute } from "@tanstack/react-router";
 *   import { toTanStackHandlers } from "@browserlessapi/inferlo/tanstack-start";
 *   import { app } from "../../inferlo/app";
 *
 *   export const Route = createFileRoute("/api/$")({
 *     server: { handlers: toTanStackHandlers(app, { prefix: "/api" }) },
 *   });
 *
 * Every request under /api runs through the Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP)
 * with /api removed from the path. In server functions and other server code, use @browserlessapi/inferlo/ai.
 * It never loads the router, database or jobs code.
 */
import type { App } from "./app.ts";
import { InferloError } from "./errors.ts";
import { normalizePrefix, stripPrefix } from "./serve.ts";

/** The part of a TanStack Start server route handler's context Inferlo uses. */
export interface TanStackHandlerContextLike {
  /** The incoming Web request. */
  request: Request;
}

/** A TanStack Start server route handler that answers with the Inferlo app's Response. */
export type TanStackRouteHandler = (ctx: TanStackHandlerContextLike) => Promise<Response>;

/** One server route handler per HTTP method, for createFileRoute(path)({ server: { handlers } }). */
export interface TanStackHandlers {
  GET: TanStackRouteHandler;
  POST: TanStackRouteHandler;
  PUT: TanStackRouteHandler;
  PATCH: TanStackRouteHandler;
  DELETE: TanStackRouteHandler;
  HEAD: TanStackRouteHandler;
  OPTIONS: TanStackRouteHandler;
}

export interface TanStackHandlersOptions {
  /**
   * The URL path of the splat route, removed before the app routes the request: "/api" for
   * createFileRoute("/api/$"). Requests outside it keep their path. Include the router's basepath if one is set.
   */
  prefix?: string;
}

const fix = 'Pass the app from createApp and the route\'s path: createFileRoute("/api/$")({ server: { handlers: toTanStackHandlers(app, { prefix: "/api" }) } }).';

/**
 * Server route handlers that run a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) from a
 * TanStack Start splat route: createFileRoute("/api/$")({ server: { handlers: toTanStackHandlers(app, { prefix: "/api" }) } }).
 */
export function toTanStackHandlers(app: Pick<App<any>, "fetch">, options: TanStackHandlersOptions = {}): TanStackHandlers {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5036", "toTanStackHandlers() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (options === null || typeof options !== "object" || (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/")))) {
    throw new InferloError("IL5036", 'toTanStackHandlers() prefix must be a path that starts with /, such as "/api".', { fix });
  }
  const prefix = normalizePrefix(options.prefix);

  const handle: TanStackRouteHandler = async (ctx) => {
    const incoming = (ctx as TanStackHandlerContextLike | undefined)?.request;
    if (!(incoming instanceof Request)) {
      throw new InferloError("IL5036", "toTanStackHandlers()'s handlers were called without a request.", {
        fix: 'Pass them as a server route\'s handlers so TanStack Start calls them with { request }: createFileRoute("/api/$")({ server: { handlers: toTanStackHandlers(app, { prefix: "/api" }) } }).',
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

  return Object.freeze({ GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle, HEAD: handle, OPTIONS: handle });
}
