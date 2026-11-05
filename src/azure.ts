/**
 * Inferlo on Azure Functions (Node.js programming model v4), without a runtime dependency on @azure/functions:
 *
 *   // src/functions/inferlo.ts
 *   import { app as azure } from "@azure/functions";
 *   import { toAzureHandler } from "@browserlessapi/inferlo/azure";
 *   import { app } from "../app.ts";
 *
 *   azure.setup({ enableHttpStream: true });
 *   azure.http("inferlo", {
 *     route: "{*path}",
 *     methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
 *     authLevel: "anonymous",
 *     handler: toAzureHandler(app, { prefix: "/api" }),
 *   });
 *
 * The handler runs the whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) for HTTP
 * trigger requests and answers with an HttpResponseInit. With enableHttpStream the answer (AI streams included)
 * is streamed to the caller as the app writes it.
 */
import type { App } from "./app.ts";
import { clientIps } from "./client-ip.ts";
import { InferloError } from "./errors.ts";

/** The parts of an Azure Functions HttpRequest (@azure/functions 4.x) that Inferlo reads. */
export interface AzureHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null; entries?(): IterableIterator<[string, string]> } & Iterable<[string, string]>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A cookie in the Azure Functions response format (Cookie from @azure/functions). */
export interface AzureCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: Date | number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  maxAge?: number;
}

/** The answer, an HttpResponseInit for @azure/functions 4.x. */
export interface AzureHttpResponseInit {
  status: number;
  headers: Record<string, string>;
  cookies: AzureCookie[];
  /** The answer's body stream (async iterable, which every @azure/functions 4.x version accepts as a body). */
  body?: ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
}

/** An Azure Functions HTTP trigger handler: handler: toAzureHandler(app, { prefix: "/api" }). */
export type AzureHttpHandler = (request: AzureHttpRequest, context?: unknown) => Promise<AzureHttpResponseInit>;

export interface AzureHandlerOptions {
  /**
   * A path prefix removed before the app routes the request. Azure Functions puts every HTTP function under
   * "/api" unless host.json sets extensions.http.routePrefix, so use { prefix: "/api" } with the default host.json.
   * Requests outside it keep their path.
   */
  prefix?: string;
}

const fix = 'Pass the app from createApp: handler: toAzureHandler(app, { prefix: "/api" }), with route: "{*path}" on azure.http(...).';

/** The caller's address: the last X-Forwarded-For entry, which the Azure front end adds, without its port. */
function azureClientIp(forwarded: string | null): string | undefined {
  const last = forwarded?.split(",").pop()?.trim();
  if (!last) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(last);
  if (bracketed) return bracketed[1];
  // IPv4 with a port ("203.0.113.9:51234"); a bare IPv6 address has more than one colon and no port.
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(last);
  return v4 ? v4[1] : last;
}

async function toRequest(request: AzureHttpRequest, prefix: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of request.headers) headers.append(name, value);
  const original = new URL(request.url);
  // The Functions host runs behind a TLS front end: use the scheme and host the caller used.
  const forwardedProto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : original.protocol.slice(0, -1);
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host") || original.host;
  let url: URL;
  try {
    url = new URL(`${proto}://${host}`);
  } catch {
    url = new URL(original.origin);
  }
  url.pathname = original.pathname;
  url.search = original.search;
  const path = url.pathname;
  if (prefix && (path === prefix || path.startsWith(prefix + "/"))) url.pathname = path.slice(prefix.length) || "/";
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
  const result = new Request(url, { method, headers, body: body && body.length ? body : undefined });
  const ip = azureClientIp(headers.get("x-forwarded-for"));
  if (ip) clientIps.set(result, ip);
  return result;
}

const SAME_SITE: Record<string, AzureCookie["sameSite"]> = { strict: "Strict", lax: "Lax", none: "None" };

/** Parses a Set-Cookie header into the Cookie object Azure Functions sends (it would keep only one Set-Cookie header). */
function parseSetCookie(header: string): AzureCookie | undefined {
  const [pair, ...attributes] = header.split(";");
  const eq = pair!.indexOf("=");
  if (eq < 1) return undefined;
  const cookie: AzureCookie = { name: pair!.slice(0, eq).trim(), value: pair!.slice(eq + 1).trim() };
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at === -1 ? "" : attribute.slice(at + 1).trim();
    if (key === "domain" && value) cookie.domain = value;
    else if (key === "path" && value) cookie.path = value;
    else if (key === "expires" && value) {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) cookie.expires = new Date(time);
    } else if (key === "max-age" && /^-?\d+$/.test(value)) cookie.maxAge = Number(value);
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite" && SAME_SITE[value.toLowerCase()]) cookie.sameSite = SAME_SITE[value.toLowerCase()];
  }
  return cookie;
}

function toResponseInit(response: Response, method: string): AzureHttpResponseInit {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) if (name !== "set-cookie") headers[name] = value;
  const cookies: AzureCookie[] = [];
  for (const header of response.headers.getSetCookie()) {
    const cookie = parseSetCookie(header);
    if (cookie) cookies.push(cookie);
  }
  const init: AzureHttpResponseInit = { status: response.status, headers, cookies };
  if (response.body && method !== "HEAD") init.body = response.body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
  return init;
}

/**
 * An Azure Functions v4 HTTP trigger handler that runs a whole Inferlo app:
 * azure.http("inferlo", { route: "{*path}", methods: [...], authLevel: "anonymous", handler: toAzureHandler(app, { prefix: "/api" }) }).
 */
export function toAzureHandler(app: Pick<App<any>, "fetch">, options: AzureHandlerOptions = {}): AzureHttpHandler {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5026", "toAzureHandler() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (
    options === null ||
    typeof options !== "object" ||
    Object.keys(options).some((key) => key !== "prefix") ||
    (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/")))
  ) {
    throw new InferloError("IL5026", 'toAzureHandler() options are { prefix }, and prefix starts with /, such as "/api".', { fix });
  }
  const prefix = (options.prefix ?? "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  return async (request) => {
    const r = request as Partial<AzureHttpRequest> | null;
    if (!r || typeof r.method !== "string" || typeof r.url !== "string" || typeof r.arrayBuffer !== "function" || !r.headers) {
      throw new InferloError("IL5026", "The handler from toAzureHandler() received something that is not an Azure Functions HTTP request.", {
        fix: "Use it as the handler of an HTTP trigger: azure.http(name, { route: \"{*path}\", handler: toAzureHandler(app, { prefix: \"/api\" }) }). Other triggers (queues, timers, blobs) need their own handler.",
      });
    }
    const response = await app.fetch(await toRequest(request, prefix));
    return toResponseInit(response, request.method.toUpperCase());
  };
}
