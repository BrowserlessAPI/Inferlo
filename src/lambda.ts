/**
 * Inferlo on AWS Lambda, without a dependency on the AWS SDK or any Lambda package:
 *
 *   // src/lambda.ts
 *   import { toLambdaHandler } from "@browserlessapi/inferlo/lambda";
 *   import { app } from "./app.ts";
 *
 *   export const handler = toLambdaHandler(app);
 *
 * The handler takes Lambda function URL and API Gateway events (HTTP API payload 2.0 and REST API payload 1.0),
 * runs the whole Inferlo app (routes, auth, validation, rate limits, OpenAPI and MCP) and answers in the
 * matching response format. With { streaming: true } it streams the answer (AI streams included) through Lambda
 * response streaming, for function URLs with the RESPONSE_STREAM invoke mode.
 */
import type { App } from "./app.ts";
import { clientIps } from "./client-ip.ts";
import { InferloError } from "./errors.ts";

/** A Lambda function URL or API Gateway HTTP API event (payload format 2.0). */
export interface LambdaHttpEventV2 {
  version: "2.0";
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: { domainName?: string; http: { method: string; sourceIp?: string } };
}

/** An API Gateway REST API event (payload format 1.0). */
export interface LambdaHttpEventV1 {
  version?: "1.0";
  httpMethod: string;
  path: string;
  headers?: Record<string, string | undefined> | null;
  multiValueHeaders?: Record<string, string[] | undefined> | null;
  queryStringParameters?: Record<string, string | undefined> | null;
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: { domainName?: string; identity?: { sourceIp?: string } };
}

export type LambdaHttpEvent = LambdaHttpEventV2 | LambdaHttpEventV1;

/** The answer for a function URL or HTTP API event. */
export interface LambdaResultV2 {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: boolean;
}

/** The answer for a REST API event. */
export interface LambdaResultV1 {
  statusCode: number;
  headers: Record<string, string>;
  multiValueHeaders: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
}

export type LambdaResult = LambdaResultV2 | LambdaResultV1;

/** A Lambda handler for HTTP events: export const handler = toLambdaHandler(app). */
export type LambdaHandler = (event: LambdaHttpEvent, context?: unknown) => Promise<LambdaResult>;

/** The writable stream Lambda passes to a streaming handler (the parts Inferlo uses). */
export interface LambdaResponseStream {
  write(chunk: Uint8Array): boolean;
  end(): void;
  once?(event: "drain" | "error" | "close", listener: (...args: unknown[]) => void): unknown;
}

/** A streaming handler, already wrapped with awslambda.streamifyResponse. */
export type LambdaStreamingHandler = (event: LambdaHttpEvent, responseStream: LambdaResponseStream, context?: unknown) => Promise<void>;

/** The parts of the awslambda global (in the Lambda Node.js runtime) that streaming uses. */
export interface AwsLambdaGlobal {
  streamifyResponse(handler: LambdaStreamingHandler): LambdaStreamingHandler;
  HttpResponseStream: { from(stream: LambdaResponseStream, metadata: { statusCode: number; headers: Record<string, string>; cookies?: string[] }): LambdaResponseStream };
}

export interface LambdaHandlerOptions {
  /**
   * A path prefix removed before the app routes the request, such as "/prod" for an HTTP API stage that is not
   * $default, or "/api" when the function serves only that path. Requests outside it keep their path.
   */
  prefix?: string;
  /** Stream the answer with Lambda response streaming (function URLs with InvokeMode RESPONSE_STREAM). Default false. */
  streaming?: boolean;
  /** The awslambda global, for tests. Default: the one the Lambda Node.js runtime provides. */
  awslambda?: AwsLambdaGlobal;
}

const fix = 'Pass the app from createApp: export const handler = toLambdaHandler(app), or toLambdaHandler(app, { prefix: "/prod", streaming: true }).';

/** Content types sent as text; everything else is base64 encoded so binary bodies arrive unchanged. */
const TEXT = /^(text\/|application\/(json|[^;]*\+json|xml|[^;]*\+xml|javascript|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i;

function isV2(event: LambdaHttpEvent): event is LambdaHttpEventV2 {
  return (event as LambdaHttpEventV2).version === "2.0" && typeof (event as LambdaHttpEventV2).rawPath === "string";
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Turns a Lambda HTTP event into a Request, and records the caller's address for rate limits by IP. */
function toRequest(event: LambdaHttpEvent, prefix: string): Request {
  const headers = new Headers();
  let method: string;
  let path: string;
  let query: string;
  let ip: string | undefined;
  if (isV2(event)) {
    method = event.requestContext.http.method;
    path = event.rawPath;
    query = event.rawQueryString ?? "";
    for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);
    // Function URLs and HTTP APIs move the Cookie header into event.cookies.
    if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));
    ip = event.requestContext.http.sourceIp;
  } else {
    method = event.httpMethod;
    path = event.path;
    const params = new URLSearchParams();
    const multiQuery = event.multiValueQueryStringParameters;
    if (multiQuery) {
      for (const [name, values] of Object.entries(multiQuery)) for (const value of values ?? []) params.append(name, value);
    } else {
      for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) if (value !== undefined) params.append(name, value);
    }
    query = params.toString();
    const multi = event.multiValueHeaders;
    if (multi) {
      for (const [name, values] of Object.entries(multi)) for (const value of values ?? []) headers.append(name, value);
    } else {
      for (const [name, value] of Object.entries(event.headers ?? {})) if (value !== undefined) headers.set(name, value);
    }
    ip = event.requestContext?.identity?.sourceIp;
  }
  if (prefix && (path === prefix || path.startsWith(prefix + "/"))) path = path.slice(prefix.length) || "/";
  const host = headers.get("host") ?? event.requestContext?.domainName ?? "localhost";
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const url = new URL(`${proto}://${host}`);
  url.pathname = path;
  url.search = query;
  const hasBody = typeof event.body === "string" && method !== "GET" && method !== "HEAD";
  const body = hasBody ? (event.isBase64Encoded ? base64ToBytes(event.body!) : event.body!) : undefined;
  const request = new Request(url, { method, headers, body });
  if (ip) clientIps.set(request, ip);
  return request;
}

/** Response headers as one value per name (Set-Cookie separately: Lambda needs each cookie on its own). */
function splitHeaders(response: Response): { headers: Record<string, string>; cookies: string[] } {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) if (name !== "set-cookie") headers[name] = value;
  return { headers, cookies: response.headers.getSetCookie() };
}

async function toResult(response: Response, v2: boolean): Promise<LambdaResult> {
  const { headers, cookies } = splitHeaders(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = bytes.length === 0 || TEXT.test(response.headers.get("content-type") ?? "");
  const body = text ? new TextDecoder().decode(bytes) : bytesToBase64(bytes);
  if (v2) {
    const result: LambdaResultV2 = { statusCode: response.status, headers, body, isBase64Encoded: !text };
    if (cookies.length) result.cookies = cookies;
    return result;
  }
  const multiValueHeaders: Record<string, string[]> = {};
  if (cookies.length) multiValueHeaders["set-cookie"] = cookies;
  return { statusCode: response.status, headers, multiValueHeaders, body, isBase64Encoded: !text };
}

async function pipe(response: Response, stream: LambdaResponseStream): Promise<void> {
  const reader = response.body?.getReader();
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length && !stream.write(value) && stream.once) await new Promise((resolve) => stream.once!("drain", resolve));
    }
  } finally {
    stream.end();
  }
}

/**
 * A Lambda handler that runs a whole Inferlo app for function URL and API Gateway events:
 * export const handler = toLambdaHandler(app). With { streaming: true }, answers stream through Lambda response streaming.
 */
export function toLambdaHandler(app: Pick<App<any>, "fetch">, options?: LambdaHandlerOptions & { streaming?: false }): LambdaHandler;
export function toLambdaHandler(app: Pick<App<any>, "fetch">, options: LambdaHandlerOptions & { streaming: true }): LambdaStreamingHandler;
export function toLambdaHandler(app: Pick<App<any>, "fetch">, options: LambdaHandlerOptions = {}): LambdaHandler | LambdaStreamingHandler {
  if (!app || typeof (app as { fetch?: unknown }).fetch !== "function") {
    throw new InferloError("IL5024", "toLambdaHandler() needs an Inferlo app (the value returned by createApp).", { fix });
  }
  if (
    options === null ||
    typeof options !== "object" ||
    (options.prefix !== undefined && (typeof options.prefix !== "string" || !options.prefix.startsWith("/"))) ||
    (options.streaming !== undefined && typeof options.streaming !== "boolean")
  ) {
    throw new InferloError("IL5024", 'toLambdaHandler() options are { prefix, streaming }: prefix starts with /, such as "/prod", and streaming is true or false.', { fix });
  }
  const prefix = (options.prefix ?? "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  const checkEvent = (event: unknown): LambdaHttpEvent => {
    const e = event as { version?: unknown; rawPath?: unknown; requestContext?: { http?: { method?: unknown } }; httpMethod?: unknown; path?: unknown } | null;
    const v2 = e?.version === "2.0" && typeof e.rawPath === "string" && typeof e.requestContext?.http?.method === "string";
    const v1 = typeof e?.httpMethod === "string" && typeof e.path === "string";
    if (!v2 && !v1) {
      throw new InferloError("IL5024", "The Lambda handler from toLambdaHandler() received an event that is not from a function URL or API Gateway.", {
        fix: "Invoke the function through a Lambda function URL or an API Gateway HTTP API or REST API (Lambda proxy integration). Other event sources (SQS, S3, schedules) need their own handler.",
      });
    }
    return event as LambdaHttpEvent;
  };

  if (!options.streaming) {
    const buffered: LambdaHandler = async (event) => {
      const checked = checkEvent(event);
      const response = await app.fetch(toRequest(checked, prefix));
      return toResult(response, isV2(checked));
    };
    return buffered;
  }

  const runtime = options.awslambda ?? (globalThis as { awslambda?: AwsLambdaGlobal }).awslambda;
  if (typeof runtime?.streamifyResponse !== "function" || typeof runtime.HttpResponseStream?.from !== "function") {
    throw new InferloError("IL5024", "toLambdaHandler(app, { streaming: true }) needs the awslambda global of the Lambda Node.js runtime, which is not available here.", {
      fix: "Streaming only works inside AWS Lambda on a Node.js runtime. Deploy it there, use toLambdaHandler(app) without streaming elsewhere, or pass { awslambda } in tests.",
    });
  }
  return runtime.streamifyResponse(async (event, responseStream) => {
    const checked = checkEvent(event);
    const response = await app.fetch(toRequest(checked, prefix));
    const { headers, cookies } = splitHeaders(response);
    const metadata: { statusCode: number; headers: Record<string, string>; cookies?: string[] } = { statusCode: response.status, headers };
    if (cookies.length) metadata.cookies = cookies;
    await pipe(response, runtime.HttpResponseStream.from(responseStream, metadata));
  });
}
