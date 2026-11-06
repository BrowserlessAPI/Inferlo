/**
 * Run an app's fetch handler as an HTTP server (Bun, Deno or Node), or inside another Node framework:
 *
 *   await serve(app, { port: 3000 })
 *   expressApp.use("/ai", toNodeHandler(app))                     // Express strips the mount path
 *   http.createServer(toNodeHandler(app, { prefix: "/ai" }))       // or strip it with prefix
 */
import { createRedactor } from "./redact.ts";
import type { App } from "./app.ts";
import { appAnswers } from "./request-matcher.ts";
import { InferloError } from "./errors.ts";
import { clientIps, clientSignals } from "./client-ip.ts";
import { knownBodies } from "./response-body.ts";
import { acceptKey, bunWebSocket, encodeClose, encodeFrame, FrameReader, OP_PONG, OP_TEXT, upgraders, type SocketListener, type SocketTransport } from "./websocket.ts";

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

export interface Server {
  port: number;
  close(): Promise<void>;
}

/**
 * The parts of a Node.js http.IncomingMessage that Inferlo reads. Express, Fastify (request.raw),
 * NestJS, Koa (ctx.req) and plain node:http requests all have this shape.
 */
export interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string; encrypted?: boolean } | null;
  /**
   * A body the host framework already read (express.json(), body-parser): a string, bytes, or a plain object or
   * array. Used instead of the stream. Instances of other classes are ignored and the stream is read.
   */
  body?: unknown;
  /**
   * The exact bytes of a body the host already read, as Google Cloud Run functions (the Functions Framework)
   * and Firebase set them. Preferred over body when present, so forms and JSON reach the app unchanged.
   */
  rawBody?: unknown;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

/** The parts of a Node.js http.ServerResponse that Inferlo writes to. */
export interface NodeResponse {
  readonly headersSent: boolean;
  readonly writableFinished?: boolean;
  writeHead(status: number, headers: Record<string, string | string[]>): unknown;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string): unknown;
  once(event: "drain", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
}

export interface NodeHandlerOptions {
  /**
   * Path the app is mounted under, for example "/ai". It is removed from the URL before routing, so
   * GET /ai/tickets matches route.get("/tickets"). Requests outside it go to next() (or get a 404).
   * Leave it out when the host framework already strips the mount path (Express app.use("/ai", ...)).
   */
  prefix?: string;
  /**
   * Pass requests the app has no route for (by method and path, outside its OpenAPI, MCP, health and metrics
   * endpoints) to the host framework's next() instead of answering 404 or 405. Mount the app before the host's
   * routes with it, to move routes to Inferlo one at a time at the same URLs. Needs an app from createApp and
   * a host that calls the handler with next (Express, NestJS, Connect). Default false.
   */
  fallthrough?: boolean;
}

export interface FromNodeRequestOptions extends NodeHandlerOptions {
  /** Aborts the request (for example when the client disconnects). */
  signal?: AbortSignal;
}

export type NodeHandler = (req: NodeRequest, res: NodeResponse, next?: (error?: unknown) => void) => Promise<void>;

export function normalizePrefix(prefix: string | undefined): string {
  if (!prefix || prefix === "/") return "";
  return ("/" + prefix.replace(/^\/+|\/+$/g, "")).replace(/\/+/g, "/");
}

/** The path and query of a Node request with the prefix removed, or null when it is outside the prefix. */
export function stripPrefix(rawUrl: string, prefix: string): string | null {
  const url = rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl;
  if (!prefix) return url;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest === "" || rest[0] === "?") return "/" + rest;
  if (rest[0] !== "/") return null;
  return rest;
}

/** Whether the app answers a method and a path (with query, prefix already removed) itself. */
function answersPath(app: object, method: string, path: string): boolean {
  let pathname = path.split("?")[0]!;
  try {
    pathname = new URL(pathname, "http://localhost").pathname;
  } catch {
    // Leave a path the URL parser rejects to the app, which answers it.
  }
  return appAnswers(app, method, pathname) === true;
}

/**
 * Whether toNodeHandler(app, { prefix, fallthrough: true }) answers a Node request itself instead of passing it
 * on. For hosts that must decide before handing the request over, such as a Fastify onRequest hook.
 */
export function answersNodeRequest(app: object, req: Pick<NodeRequest, "url" | "method">, prefix?: string): boolean {
  const path = stripPrefix(req.url ?? "/", normalizePrefix(prefix));
  return path !== null && answersPath(app, req.method ?? "GET", path);
}

function bodyStream(req: NodeRequest): ReadableStream<Uint8Array> {
  const iterator = req[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) return controller.close();
        controller.enqueue(typeof value === "string" ? new TextEncoder().encode(value) : (value as Uint8Array));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * True when req.body holds a body the host framework already read: a string or bytes (body-parser text and
 * raw), or a plain object or array (express.json(), urlencoded forms). An instance of some other class is the
 * host's own object, such as the body reader of an Encore raw request, and the stream is read instead.
 */
function isParsedBody(body: unknown): boolean {
  if (body === undefined) return false;
  if (body === null || typeof body !== "object" || body instanceof Uint8Array || Array.isArray(body)) return true;
  const proto = Object.getPrototypeOf(body);
  return proto === Object.prototype || proto === null;
}

export function buildRequest(req: NodeRequest, path: string, signal?: AbortSignal): Request {
  const host = [req.headers.host].flat()[0] ?? "localhost";
  const url = new URL(path, `${req.socket?.encrypted ? "https" : "http"}://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.startsWith(":")) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  const method = (req.method ?? "GET").toUpperCase();
  let body: BodyInit | ReadableStream | undefined;
  if (method !== "GET" && method !== "HEAD") {
    if (req.rawBody instanceof Uint8Array && isParsedBody(req.body)) {
      // The host read the stream and kept the bytes: the app gets them unchanged, with their own content type.
      headers.delete("content-length");
      body = req.rawBody as Uint8Array<ArrayBuffer>;
    } else if (isParsedBody(req.body)) {
      // The host framework already read the stream: use what it parsed.
      headers.delete("content-length");
      if (typeof req.body === "string" || req.body instanceof Uint8Array) body = req.body as BodyInit;
      else {
        body = JSON.stringify(req.body);
        headers.set("content-type", "application/json");
      }
    } else body = bodyStream(req);
  }
  const request = new Request(url, {
    method,
    headers,
    body,
    signal,
    // @ts-expect-error duplex is required by Node for streaming bodies
    duplex: "half",
  });
  if (req.socket?.remoteAddress) clientIps.set(request, req.socket.remoteAddress);
  return request;
}

/**
 * Convert a Node.js request (node:http, Express, Fastify's request.raw, NestJS) to a Web Request.
 * With prefix, the prefix is removed from the path; a request outside it keeps its path.
 */
export function fromNodeRequest(req: NodeRequest, options: FromNodeRequestOptions = {}): Request {
  const raw = req.url ?? "/";
  const path = stripPrefix(raw, normalizePrefix(options.prefix)) ?? (raw.startsWith("/") ? raw : "/" + raw);
  return buildRequest(req, path, options.signal);
}

const encoder = new TextEncoder();
/** UTF-8 length of a string, with Buffer where the runtime has it (Node.js, Bun). */
function byteLength(text: string): number {
  const B = (globalThis as { Buffer?: { byteLength(text: string): number } }).Buffer;
  return B ? B.byteLength(text) : encoder.encode(text).byteLength;
}

/** Write a Web Response (status, headers with every Set-Cookie, streamed body) to a Node response. */
export async function writeResponse(res: NodeResponse, response: Response, method: string): Promise<void> {
  const outHeaders: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    outHeaders[key] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) outHeaders["set-cookie"] = cookies;
  // A JSON answer Inferlo built from a string: headers and body in one write, with its length.
  const known = knownBodies.get(response);
  if (known !== undefined && !response.bodyUsed && method !== "HEAD" && outHeaders["content-length"] === undefined && outHeaders["transfer-encoding"] === undefined) {
    outHeaders["content-length"] = String(byteLength(known));
    res.writeHead(response.status, outHeaders);
    return void res.end(known);
  }
  res.writeHead(response.status, outHeaders);
  if (!response.body || method === "HEAD") return void res.end();
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise<void>((r) => res.once("drain", () => r()));
  }
  res.end();
}

/**
 * A (req, res, next) handler that runs a whole Inferlo app (routes, OpenAPI, MCP) inside node:http,
 * Express, Fastify, NestJS or any framework that hands out Node requests and responses.
 */
export function toNodeHandler(app: Pick<App<any>, "fetch">, options: NodeHandlerOptions = {}): NodeHandler {
  const prefix = normalizePrefix(options.prefix);
  if (options.fallthrough !== undefined && typeof options.fallthrough !== "boolean") {
    throw new InferloError("IL5019", "toNodeHandler fallthrough must be true or false.", { fix: "Use toNodeHandler(app, { fallthrough: true })." });
  }
  if (options.fallthrough && appAnswers(app, "GET", "/") === undefined) {
    throw new InferloError("IL5019", "toNodeHandler(app, { fallthrough: true }) needs an app from createApp.", {
      fix: "Pass the app returned by createApp, which knows its routes; a plain fetch handler cannot tell which requests to pass on.",
    });
  }
  return async (req, res, next) => {
    const path = stripPrefix(req.url ?? "/", prefix);
    if (path === null && next) return next();
    if (options.fallthrough && next && path !== null && !answersPath(app, req.method ?? "GET", path)) return next();
    try {
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const request = buildRequest(req, path ?? (req.url ?? "/"));
      clientSignals.set(request, controller.signal);
      const response = await app.fetch(request);
      await writeResponse(res, response, request.method);
    } catch (error) {
      console.error("[inferlo] server error", createRedactor([]).value(error));
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "IL9000", message: "Internal server error" } }));
    }
  };
}

export async function serve(app: Pick<App<any>, "fetch">, options: ServeOptions = {}): Promise<Server> {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? "0.0.0.0";
  const g = globalThis as {
    Bun?: { serve(o: object): { port: number; pendingRequests: number; stop(closeActiveConnections?: boolean): Promise<void> | void } };
    Deno?: { serve(o: object, h: (r: Request, info: unknown) => Promise<Response>): { addr: { port: number }; shutdown(): Promise<void> } };
  };

  if (g.Bun) {
    // app.fetch upgrades WebSocket routes through the Bun server it is given, with bunWebSocket's handlers.
    const server = g.Bun.serve({ port, hostname, fetch: (req: Request, bunServer: unknown) => app.fetch(req, bunServer), websocket: bunWebSocket });
    // Wait until the open requests (and streamed answers) are done, then stop, closing the idle keep-alive
    // connections too. Requests that arrive meanwhile get 503 IL2006 from app.close(). app.close() calls the force
    // closer, stop(true), when its timeout is up. (stop() without true would leave keep-alive connections served on
    // Bun 1.3, and a later stop(true) would then do nothing.)
    let forced = false;
    const result: Server = {
      port: server.port,
      close: async () => {
        while (server.pendingRequests > 0 && !forced) await new Promise((resolve) => setTimeout(resolve, 20));
        await server.stop(true);
      },
    };
    forceClosers.set(result, () => {
      forced = true;
      void server.stop(true);
    });
    return result;
  }
  if (g.Deno) {
    // shutdown() waits for every open request and streamed answer, with no way to cut them off. So each answer
    // with a body is passed through a stream that the force closer can abort when app.close()'s timeout is up.
    const open = new Set<AbortController>();
    const server = g.Deno.serve({ port, hostname, onListen() {} }, async (req, info) => {
      const response = await app.fetch(req, info);
      if (!response.body) return response;
      const abort = new AbortController();
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      open.add(abort);
      void response.body
        .pipeTo(writable, { signal: abort.signal })
        .catch(() => {})
        .finally(() => open.delete(abort));
      return new Response(readable, { status: response.status, statusText: response.statusText, headers: response.headers });
    });
    const result: Server = { port: server.addr.port, close: () => server.shutdown() };
    forceClosers.set(result, () => {
      for (const abort of open) abort.abort();
    });
    return result;
  }

  const http = await import("node:http");
  const handler = toNodeHandler(app);
  const server = http.createServer((req, res) => void handler(req as NodeRequest, res));
  server.on("upgrade", toNodeUpgradeHandler(app) as (...args: unknown[]) => void);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });
  const address = server.address();
  const result: Server = {
    port: typeof address === "object" && address ? address.port : port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
  forceClosers.set(result, () => server.closeAllConnections());
  return result;
}

/** The parts of a Node.js net.Socket (the socket of an "upgrade" event) an upgraded connection uses. */
export interface NodeSocket {
  write(data: Uint8Array | string): boolean;
  end(data?: Uint8Array | string): void;
  destroy(): void;
  setNoDelay?(noDelay: boolean): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "close" | "end", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/** Longest message a WebSocket on Node.js may send before it is closed with 1009 (the app checks its own maxBodySize too). */
const MAX_SOCKET_MESSAGE = 16 * 1024 * 1024;

export type NodeUpgradeHandler = (req: NodeRequest, socket: NodeSocket, head: Uint8Array) => void;

const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 422: "Unprocessable Entity", 426: "Upgrade Required", 429: "Too Many Requests", 500: "Internal Server Error", 501: "Not Implemented", 503: "Service Unavailable" };

/**
 * A listener for a Node.js server's "upgrade" event that serves the app's WebSocket routes (route.ws), for servers
 * that another framework created: server.on("upgrade", toNodeUpgradeHandler(app, { prefix: "/api" })). Upgrade
 * requests outside the prefix are left to the server's other "upgrade" listeners, and so are paths the app has no
 * route for when fallthrough is true; otherwise the app answers them (404).
 */
export function toNodeUpgradeHandler(app: Pick<App<any>, "fetch">, options: NodeHandlerOptions = {}): NodeUpgradeHandler {
  const prefix = normalizePrefix(options.prefix);
  if (options.fallthrough !== undefined && typeof options.fallthrough !== "boolean") {
    throw new InferloError("IL5019", "toNodeUpgradeHandler fallthrough must be true or false.", { fix: "Use toNodeUpgradeHandler(app, { fallthrough: true })." });
  }
  if (options.fallthrough && appAnswers(app, "GET", "/") === undefined) {
    throw new InferloError("IL5019", "toNodeUpgradeHandler(app, { fallthrough: true }) needs an app from createApp.", { fix: "Pass the app returned by createApp, which knows its routes." });
  }
  return (req, socket, head) => {
    const path = stripPrefix(req.url ?? "/", prefix);
    if (path === null) return;
    if (options.fallthrough && !answersPath(app, "GET", path)) return;
    void nodeUpgrade(app, req, socket, head, path);
  };
}

/**
 * A Node.js upgrade request: the app decides (auth, permissions, rate limits, the route); when it accepts, the
 * handshake is answered here and the connection speaks RFC 6455 frames. Otherwise the app's answer is written as a
 * plain HTTP response and the connection is closed.
 */
async function nodeUpgrade(app: Pick<App<any>, "fetch">, req: NodeRequest, socket: NodeSocket, head: Uint8Array, path: string): Promise<void> {
  socket.on("error", () => {});
  let accepted = false;
  try {
    const request = buildRequest(req, path);
    upgraders.set(request, async (connect) => {
      const accept = await acceptKey(request.headers.get("sec-websocket-key") ?? "");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      accepted = true;
      socket.setNoDelay?.(true);
      nodeSocket(socket, connect, head);
      return undefined;
    });
    const response = await app.fetch(request);
    if (accepted) return;
    const body = new Uint8Array(await response.arrayBuffer());
    const lines = [`HTTP/1.1 ${response.status} ${STATUS_TEXT[response.status] ?? ""}`];
    response.headers.forEach((value, key) => {
      if (key !== "content-length" && key !== "connection" && key !== "transfer-encoding") lines.push(`${key}: ${value}`);
    });
    lines.push(`content-length: ${body.byteLength}`, "connection: close", "", "");
    socket.write(lines.join("\r\n"));
    socket.end(body);
  } catch (error) {
    console.error("[inferlo] server error", createRedactor([]).value(error));
    if (!accepted) socket.end("HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    else socket.destroy();
  }
}

/** Runs one accepted connection: frames in, frames out, and the close handshake. */
function nodeSocket(socket: NodeSocket, connect: (transport: SocketTransport) => SocketListener, head: Uint8Array): void {
  const encoder = new TextEncoder();
  let closeSent = false;
  let gone = false;
  let code = 1006;
  let reason = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sendClose = (closeCode: number, closeReason: string) => {
    if (closeSent || gone) return;
    closeSent = true;
    socket.write(closeCode === 1005 ? encodeFrame(0x8, new Uint8Array(0)) : encodeClose(closeCode, closeReason));
    // Wait for the client's close frame, but not forever.
    timer = setTimeout(() => socket.destroy(), 5000);
  };
  const listener = connect({
    send: (text) => {
      if (!closeSent && !gone) socket.write(encodeFrame(OP_TEXT, encoder.encode(text)));
    },
    close: (closeCode, closeReason) => {
      code = closeCode;
      reason = closeReason;
      sendClose(closeCode, closeReason);
    },
  });
  const reader = new FrameReader(MAX_SOCKET_MESSAGE, {
    message: (data) => listener.message(data),
    ping: (payload) => {
      if (!closeSent) socket.write(encodeFrame(OP_PONG, payload));
    },
    close: (clientCode, clientReason) => {
      if (!closeSent) {
        code = clientCode;
        reason = clientReason;
      }
      sendClose(clientCode, clientReason);
      socket.end();
    },
    error: (errorCode, errorReason) => {
      code = errorCode;
      reason = errorReason;
      sendClose(errorCode, errorReason);
      socket.end();
    },
  });
  socket.on("data", (chunk) => reader.push(chunk));
  socket.on("close", () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    listener.close(code, reason);
  });
  if (head.byteLength) reader.push(head);
}

/** Closes every open connection of a server from serve() (Node.js, Bun and Deno), for app.close() after its timeout. */
export const forceClosers = new WeakMap<Server, () => void>();
