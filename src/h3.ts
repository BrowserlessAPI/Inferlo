/**
 * Inferlo inside h3 (1 and 2), Nitro and Nuxt server routes, without a runtime dependency on h3:
 *
 *   // server/routes/api/[...path].ts (Nitro or Nuxt)
 *   import { toH3Handler } from "@browserlessapi/inferlo/h3";
 *   import { app } from "../../inferlo/app";
 *
 *   export default toH3Handler(app, { prefix: "/api" });
 *
 *   // server/plugins/ai.ts: event.context.ai in every server route
 *   import { inferloAI } from "@browserlessapi/inferlo/h3";
 *   export default defineNitroPlugin(inferloAI(ai));
 *
 * It never loads the router, database or jobs code.
 */
import type { H3EventContext } from "h3";
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";
import type { App } from "./app.ts";
import { clientIps } from "./client-ip.ts";
import { InferloError } from "./errors.ts";
import { buildRequest, normalizePrefix, stripPrefix, type NodeRequest } from "./serve.ts";

declare module "h3" {
  interface H3EventContext {
    /** The AI client from the inferloAI() Nitro plugin of @browserlessapi/inferlo/h3. */
    ai: AI;
  }
}

/** The parts of an h3 1 or h3 2 event Inferlo uses. */
export interface H3EventLike {
  /** h3 2: the Web request (and event.url, the parsed URL). */
  req?: { url: string; method: string; headers: HeadersInit; body?: ReadableStream<Uint8Array> | null; signal?: AbortSignal; ip?: string };
  url?: URL;
  /** h3 1: the Node request and response, and event.path (after an app.use() prefix). h3 2 has node on Node.js too. */
  node?: { req: unknown; res: { on(event: "close", listener: () => void): unknown; writableFinished?: boolean } };
  path?: string;
  /** event.context, where the inferloAI() plugin puts ai. */
  context: H3EventContext | Record<string, unknown>;
}

/** An h3 event handler: export it from a Nitro server route, or pass it to app.use() or router.add(). */
export type H3Handler = ((event: H3EventLike) => Promise<Response>) & { readonly __is_handler__: true };

export interface H3HandlerOptions {
  /**
   * The path the handler is served under, removed before the app routes the request: "/api" for
   * server/routes/api/[...path].ts. Requests outside it keep their path. Leave it out when h3 already removed the
   * path (h3 1 app.use("/api", handler)).
   */
  prefix?: string;
}

/** A Nitro plugin: export default defineNitroPlugin(inferloAI(ai)). */
export type NitroPlugin = (nitroApp: { hooks: { hook(name: "request", fn: (event: H3EventLike) => void): unknown } }) => void;

const fix = 'Pass the app from createApp and the route\'s path: export default toH3Handler(app, { prefix: "/api" }).';

/**
 * An h3 event handler that runs a whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP), for
 * Nitro and Nuxt server routes and h3 apps, on h3 1 (Nuxt 3 and 4, Nitro 2) and h3 2 (Nitro 3).
 */
export function toH3Handler(app: Pick<App<any>, "fetch">, options: H3HandlerOptions = {}): H3Handler {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5021", "toH3Handler() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (options === null || typeof options !== "object" || (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/")))) {
    throw new InferloError("IL5021", 'toH3Handler() prefix must be a path that starts with /, such as "/api".', { fix });
  }
  const prefix = normalizePrefix(options.prefix);

  const handler = async (event: H3EventLike): Promise<Response> => {
    const e = event as H3EventLike | undefined;
    // h3 2: the event carries a Web request.
    if (e?.req && e.url instanceof URL) {
      const url = new URL(e.url.href);
      url.pathname = stripPrefix(url.pathname, prefix) ?? url.pathname;
      const method = e.req.method.toUpperCase();
      const hasBody = e.req.body != null && method !== "GET" && method !== "HEAD";
      const init: RequestInit & { duplex?: "half" } = { method, headers: e.req.headers, body: hasBody ? e.req.body : undefined, signal: e.req.signal };
      if (hasBody) init.duplex = "half";
      const request = new Request(url, init);
      if (typeof e.req.ip === "string" && e.req.ip) clientIps.set(request, e.req.ip);
      return app.fetch(request);
    }
    // h3 1: the event carries Node's request and response.
    if (e?.node?.req) {
      const raw = typeof e.path === "string" ? e.path : ((e.node.req as NodeRequest).url ?? "/");
      const controller = new AbortController();
      e.node.res.on("close", () => {
        if (!e.node!.res.writableFinished) controller.abort();
      });
      return app.fetch(buildRequest(e.node.req as NodeRequest, stripPrefix(raw, prefix) ?? raw, controller.signal));
    }
    throw new InferloError("IL5021", "toH3Handler()'s handler was called with something that is not an h3 event.", { fix: "Export it from a Nitro server route or pass it to an h3 app: app.use(\"/api/**\", toH3Handler(inferlo, { prefix: \"/api\" }))." });
  };
  // Marks it as an event handler for h3 1 (what defineEventHandler does); h3 2 takes plain functions.
  return Object.assign(handler, { __is_handler__: true as const });
}

/**
 * A Nitro plugin that puts an AI client (createAI(...) or an Inferlo app's app.ai) on every request as
 * event.context.ai: export default defineNitroPlugin(inferloAI(ai)) in server/plugins/ai.ts.
 */
export function inferloAI(ai: AI): NitroPlugin {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: export default defineNitroPlugin(inferloAI(ai)).');
  return (nitroApp) => {
    nitroApp.hooks.hook("request", (event) => {
      event.context.ai = ai;
    });
  };
}
