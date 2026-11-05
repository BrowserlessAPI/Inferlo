/**
 * Inferlo inside Next.js App Router route handlers (Next.js 15 and 16), without a runtime dependency on Next.js:
 *
 *   // app/api/[[...path]]/route.ts
 *   import { toNextHandlers } from "@browserlessapi/inferlo/nextjs";
 *   import { app } from "@/inferlo/app";
 *
 *   export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = toNextHandlers(app, { prefix: "/api" });
 *
 * Every request under /api runs through the Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP)
 * with /api removed from the path. In server actions and other server code, use @browserlessapi/inferlo/ai.
 * It never loads the router, database or jobs code.
 */
import type { App } from "./app.ts";
import { InferloError } from "./errors.ts";

/** A Next.js route handler: it takes the Request (a NextRequest in Next.js) and returns a Response. */
export type NextRouteHandler = (request: Request, context?: unknown) => Promise<Response>;

/** One route handler per HTTP method, to export from an app/.../route.ts file. */
export interface NextHandlers {
  GET: NextRouteHandler;
  POST: NextRouteHandler;
  PUT: NextRouteHandler;
  PATCH: NextRouteHandler;
  DELETE: NextRouteHandler;
  HEAD: NextRouteHandler;
  OPTIONS: NextRouteHandler;
}

export interface NextHandlersOptions {
  /**
   * The URL path of the route.ts folder, removed before the app routes the request: "/api" for
   * app/api/[[...path]]/route.ts. Requests outside it keep their path. Include Next.js's basePath if one is set.
   */
  prefix?: string;
}

const fix = 'Pass the app from createApp and a path prefix: export const { GET, POST } = toNextHandlers(app, { prefix: "/api" }).';

/** Route handlers that run a whole Inferlo app from a Next.js catch-all route: export const { GET, POST } = toNextHandlers(app). */
export function toNextHandlers(app: Pick<App<any>, "fetch">, options: NextHandlersOptions = {}): NextHandlers {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5020", "toNextHandlers() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (options === null || typeof options !== "object" || (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/")))) {
    throw new InferloError("IL5020", "toNextHandlers() prefix must be a path that starts with /, such as \"/api\".", { fix });
  }
  const prefix = (options.prefix ?? "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");

  const handle: NextRouteHandler = async (request) => {
    if (!prefix) return app.fetch(request);
    const url = new URL(request.url);
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) return app.fetch(request);
    url.pathname = url.pathname.slice(prefix.length) || "/";
    const hasBody = request.body !== null && request.method !== "GET" && request.method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      signal: request.signal,
      redirect: request.redirect,
    };
    if (hasBody) init.duplex = "half";
    return app.fetch(new Request(url, init));
  };

  return Object.freeze({ GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle, HEAD: handle, OPTIONS: handle });
}
