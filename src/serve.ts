/**
 * Run an app's fetch handler as an HTTP server (Bun, Deno or Node), or inside another Node framework:
 *
 *   await serve(app, { port: 3000 })
 *   expressApp.use("/ai", toNodeHandler(app))                     // Express strips the mount path
 *   http.createServer(toNodeHandler(app, { prefix: "/ai" }))       // or strip it with prefix
 */
import type { App } from "./app.ts";
import { clientIps } from "./client-ip.ts";

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
  /** A body the host framework already read (express.json(), body-parser). Used instead of the stream. */
  body?: unknown;
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
}

export interface FromNodeRequestOptions extends NodeHandlerOptions {
  /** Aborts the request (for example when the client disconnects). */
  signal?: AbortSignal;
}

export type NodeHandler = (req: NodeRequest, res: NodeResponse, next?: (error?: unknown) => void) => Promise<void>;

function normalizePrefix(prefix: string | undefined): string {
  if (!prefix || prefix === "/") return "";
  return ("/" + prefix.replace(/^\/+|\/+$/g, "")).replace(/\/+/g, "/");
}

/** The path and query of a Node request with the prefix removed, or null when it is outside the prefix. */
function stripPrefix(rawUrl: string, prefix: string): string | null {
  const url = rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl;
  if (!prefix) return url;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest === "" || rest[0] === "?") return "/" + rest;
  if (rest[0] !== "/") return null;
  return rest;
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

function buildRequest(req: NodeRequest, path: string, signal?: AbortSignal): Request {
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
    if (req.body !== undefined) {
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

async function writeResponse(res: NodeResponse, response: Response, method: string): Promise<void> {
  const outHeaders: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    outHeaders[key] = value;
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) outHeaders["set-cookie"] = cookies;
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
  return async (req, res, next) => {
    const path = stripPrefix(req.url ?? "/", prefix);
    if (path === null && next) return next();
    try {
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const request = buildRequest(req, path ?? (req.url ?? "/"), controller.signal);
      const response = await app.fetch(request);
      await writeResponse(res, response, request.method);
    } catch (error) {
      console.error("[inferlo] server error", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "IL9000", message: "Internal server error" } }));
    }
  };
}

export async function serve(app: Pick<App<any>, "fetch">, options: ServeOptions = {}): Promise<Server> {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? "0.0.0.0";
  const g = globalThis as {
    Bun?: { serve(o: object): { port: number; stop(force?: boolean): void } };
    Deno?: { serve(o: object, h: (r: Request, info: unknown) => Promise<Response>): { addr: { port: number }; shutdown(): Promise<void> } };
  };

  if (g.Bun) {
    const server = g.Bun.serve({ port, hostname, fetch: (req: Request, bunServer: unknown) => app.fetch(req, bunServer) });
    return { port: server.port, close: async () => server.stop(true) };
  }
  if (g.Deno) {
    const server = g.Deno.serve({ port, hostname }, (req, info) => app.fetch(req, info));
    return { port: server.addr.port, close: () => server.shutdown() };
  }

  const http = await import("node:http");
  const handler = toNodeHandler(app);
  const server = http.createServer((req, res) => void handler(req as NodeRequest, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
