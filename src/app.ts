/**
 * createApp wires models, routes, database, auth and AI together and gives you a standard
 * fetch(Request) => Response handler that runs on Node, Bun, Deno and edge runtimes.
 */
import { bindTools, createAI, type AI, type AIConfig } from "./ai/index.ts";
import { memory } from "./db/memory.ts";
import { createDb, type Db } from "./db/table.ts";
import type { Adapter } from "./db/types.ts";
import { describeApp, type AppDescription } from "./describe.ts";
import { InferloError, didYouMean, suggest } from "./errors.ts";
import { callTool, handleMcp, toolDefinition } from "./mcp.ts";
import type { AnyModel } from "./model.ts";
import { buildOpenAPI } from "./openapi.ts";
import { isRoute, type AnyContext, type AppDb, type AppUser, type Method, type RouteDef } from "./route.ts";
import { checkRateLimit, databaseRateLimitStore, memoryRateLimitStore, rateLimitResult, windowMs, type RateLimitConfig, type RateLimitStore } from "./rate-limit.ts";
import { clientIp, clientIps } from "./client-ip.ts";
import { collectJobs, createJobs, jobStoreFor, type AppJobs, type JobQueueConfig, type JobSource } from "./jobs.ts";
import { ValidationError, type AnySchema } from "./schema.ts";

export interface AuthConfig {
  /** Return the signed-in user for this request, or null. */
  resolve(req: Request, ctx: { db: AppDb; url: URL }): AppUser | null | undefined | Promise<AppUser | null | undefined>;
  /** Roles of a user, checked when a route uses auth: "<role>". Default: user.roles ?? []. */
  roles?(user: AppUser): string[];
}

export interface CorsConfig {
  /** Allowed origins, or "*". */
  origin: string | string[];
  credentials?: boolean;
  headers?: string[];
  maxAge?: number;
}

export interface MiddlewareContext {
  req: Request;
  url: URL;
  state: Record<string, unknown>;
}
export type Middleware = (ctx: MiddlewareContext, next: () => Promise<Response>) => Promise<Response>;

export interface Logger {
  info(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Anything that contains routes: a route, an array, or a module (import * as tickets from "./routes/tickets.ts"). */
export type RouteSource = RouteDef | readonly RouteSource[] | { readonly [name: string]: unknown };

export interface AppConfig<Models extends readonly AnyModel[]> {
  /** Shown in OpenAPI, MCP and describe. */
  name?: string;
  version?: string;
  description?: string;
  models?: Models;
  routes?: RouteSource[];
  /** Background jobs: jobs, arrays or modules (import * as jobs from "./jobs.ts"). */
  jobs?: JobSource[];
  /** Where queued jobs are kept: { store: "memory" } (default) or { store: "database" } (Postgres table inferlo_jobs, shared by every instance). */
  jobQueue?: JobQueueConfig;
  /** Database adapter. Default: memory(). Use postgres() from "@browserlessapi/inferlo/postgres" in production. */
  db?: Adapter;
  auth?: AuthConfig;
  ai?: AIConfig;
  cors?: boolean | CorsConfig;
  middleware?: Middleware[];
  /** Path for the OpenAPI document, or false to disable. Default "/openapi.json". */
  openapi?: string | false;
  /** Path for the MCP endpoint, or false to disable. Default "/mcp" when any route sets tool. */
  mcp?: string | false;
  /** Maximum request body in bytes. Default 1 MiB. */
  maxBodySize?: number;
  /** Where route rateLimit counts are kept: { store: "memory" } (default) or { store: "database" } (Postgres, shared by every instance). */
  rateLimit?: RateLimitConfig;
  /**
   * Behind a load balancer or proxy that sets X-Forwarded-For: true uses its first address as the client IP
   * (for rateLimit by "ip"). Default false, because clients can send that header themselves.
   */
  trustProxy?: boolean;
  /** Include error messages of unexpected (500) errors in responses. Default false. */
  exposeErrors?: boolean;
  logger?: Logger;
}

interface CompiledRoute {
  def: RouteDef;
  regex: RegExp;
  keys: string[];
  score: number;
}

export interface RequestOptions {
  method?: Method | Lowercase<Method> | "OPTIONS" | "HEAD";
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  body?: BodyInit;
  query?: Record<string, string | number | boolean | undefined>;
  /** Run as this user, skipping auth.resolve (tests only, never reachable over HTTP). */
  as?: AppUser | null;
}

export interface App<Models extends readonly AnyModel[]> {
  readonly name: string;
  readonly version: string;
  readonly routes: readonly RouteDef[];
  readonly models: Models;
  readonly db: Db<Models>;
  readonly ai: AI;
  /** Background jobs: app.jobs.enqueue(job, input), app.jobs.start() to run them, app.jobs.runDue() in tests. */
  readonly jobs: AppJobs;
  /** Standard fetch handler: export default app works on Bun, Deno and Cloudflare Workers. */
  fetch(req: Request, ...rest: unknown[]): Promise<Response>;
  /** In-process request for tests: await app.request("/tickets", { method: "POST", json: {...}, as: user }). */
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** Start an HTTP server (Node, Bun or Deno). */
  listen(port?: number, hostname?: string): Promise<{ port: number; close(): Promise<void> }>;
  /** Machine-readable map of the whole app: routes, models, auth and AI. */
  describe(): AppDescription;
  openapi(): Record<string, unknown>;
}

const testUsers = new WeakMap<Request, AppUser | null>();

function compile(def: RouteDef): CompiledRoute {
  if (!def.path.startsWith("/")) {
    throw new InferloError("IL6003", `Route path "${def.path}" must start with "/".`, { fix: `Use "/${def.path}".` });
  }
  const keys: string[] = [];
  let score = 0;
  const parts = def.path.split("/").filter(Boolean);
  const pattern = parts
    .map((part, i) => {
      if (part === "*" && i === parts.length - 1) {
        keys.push("*");
        return "(?:/(.*))?";
      }
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        score += 1;
        return "/([^/]+)";
      }
      score += 3;
      return "/" + part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { def, regex: new RegExp(`^${pattern || ""}/?$`), keys, score: score * 10 + parts.length };
}

function collectRoutes(sources: RouteSource[] | undefined): RouteDef[] {
  const out: RouteDef[] = [];
  const seen = new Set<unknown>();
  const visit = (source: unknown, name?: string) => {
    if (!source || typeof source !== "object" || seen.has(source)) return;
    seen.add(source);
    if (isRoute(source)) {
      out.push(name && !source.name ? { ...source, name } : source);
      return;
    }
    if (Array.isArray(source)) {
      for (const item of source) visit(item);
      return;
    }
    for (const [key, value] of Object.entries(source)) if (isRoute(value) || Array.isArray(value)) visit(value, key === "default" ? undefined : key);
  };
  visit(sources);
  return out;
}

function corsHeaders(config: CorsConfig, origin: string | null): Record<string, string> {
  const allowed = config.origin === "*" ? "*" : origin && (Array.isArray(config.origin) ? config.origin : [config.origin]).includes(origin) ? origin : null;
  if (!allowed) return {};
  const h: Record<string, string> = { "access-control-allow-origin": allowed, vary: "origin" };
  if (config.credentials) h["access-control-allow-credentials"] = "true";
  return h;
}

async function readBody(req: Request, limit: number): Promise<string> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > limit) throw new InferloError("IL2004", `Request body is larger than ${limit} bytes.`, { status: 413 });
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new InferloError("IL2004", `Request body is larger than ${limit} bytes.`, { status: 413 });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function queryObject(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

function json(data: unknown, status: number, headers: Headers): Response {
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export function createApp<const Models extends readonly AnyModel[] = []>(config: AppConfig<Models> = {}): App<Models> {
  const logger: Logger = config.logger ?? {
    info: (m, d) => console.log(`[inferlo] ${m}`, d ?? ""),
    error: (m, d) => console.error(`[inferlo] ${m}`, d ?? ""),
  };
  const models = (config.models ?? []) as unknown as Models;
  const modelNames = new Set<string>();
  for (const m of models) {
    if (modelNames.has(m.name)) throw new InferloError("IL6004", `Two models are named "${m.name}".`, { fix: "Model names must be unique." });
    modelNames.add(m.name);
  }
  for (const m of models) {
    for (const [field, schema] of Object.entries(m.fields as Record<string, AnySchema>)) {
      const ref = schema.def.refTable;
      if (ref && !modelNames.has(ref)) {
        throw new InferloError("IL6005", `${m.name}.${field} references "${ref}", which is not a registered model.${didYouMean(ref, modelNames)}`, {
          fix: `Add the "${ref}" model to createApp({ models: [...] }) or fix the name in t.ref().`,
        });
      }
    }
  }

  const routes = collectRoutes(config.routes);
  const compiled = routes.map(compile).sort((a, b) => b.score - a.score);
  const signatures = new Map<string, RouteDef>();
  for (const r of routes) {
    const sig = `${r.method} ${r.path.replace(/:[^/]+/g, ":")}`;
    if (signatures.has(sig)) {
      throw new InferloError("IL6001", `Duplicate route ${r.method} ${r.path}.`, { fix: "Each method and path may only be defined once." });
    }
    signatures.set(sig, r);
  }
  const names = new Map<string, RouteDef>();
  for (const r of routes) {
    if (!r.name) continue;
    if (names.has(r.name) && names.get(r.name) !== r) {
      throw new InferloError("IL6006", `Two routes are exported as "${r.name}".`, { fix: "Give each route export a unique name; it is used for MCP tools and describe." });
    }
    names.set(r.name, r);
  }
  const needsAuth = routes.filter((r) => (r.options.auth ?? "user") !== "public");
  if (needsAuth.length && !config.auth) {
    throw new InferloError("IL3003", `${needsAuth.length} route(s) require a signed-in user, but createApp has no auth configured: ${needsAuth.map((r) => `${r.method} ${r.path}`).join(", ")}.`, {
      fix: 'Routes are private by default. Add auth: "public" to routes anyone may call, or pass createApp({ auth: { resolve(req) { ... } } }).',
    });
  }

  for (const r of routes) if (r.options.rateLimit !== undefined) checkRateLimit(r.options.rateLimit, `${r.method} ${r.path}`);
  const storeName = config.rateLimit?.store ?? "memory";
  if (storeName !== "memory" && storeName !== "database") {
    throw new InferloError("IL6007", `Invalid rateLimit store "${String(storeName)}".`, { fix: 'Use createApp({ rateLimit: { store: "memory" } }) or { store: "database" }.' });
  }

  const adapter = config.db ?? memory();
  const db = createDb(models, adapter);
  const rateLimits: RateLimitStore = storeName === "database" ? databaseRateLimitStore(adapter) : memoryRateLimitStore();
  const ai = createAI(config.ai);
  const jobs = createJobs(collectJobs(config.jobs), { db: db as never, ai, store: jobStoreFor(config.jobQueue, adapter), queue: config.jobQueue?.store ?? "memory", logger });
  const maxBody = config.maxBodySize ?? 1024 * 1024;
  const cors: CorsConfig | undefined = config.cors === true ? { origin: "*" } : config.cors || undefined;
  const openapiPath = config.openapi === undefined ? "/openapi.json" : config.openapi;
  const hasTools = routes.some((r) => r.options.tool);
  const mcpPath = config.mcp === undefined ? (hasTools ? "/mcp" : false) : config.mcp;

  // Routes passed to ai.generate({ tools }) are matched to the registered route by method and path.
  const registeredTool = (route: RouteDef) => {
    const found = routes.find((r) => r.method === route?.method && r.path === route?.path);
    if (!found) {
      throw new InferloError("IL5011", `Tool ${route?.method} ${route?.path} is not a route of this app.`, {
        fix: "Pass routes that are registered in createApp({ routes }) to ai.generate({ tools }).",
      });
    }
    return toolDefinition(found);
  };
  const describeTool = (route: RouteDef) => {
    const { name, description, inputSchema } = registeredTool(route);
    return { name, description, inputSchema };
  };
  const toolsFor = (req: Request): AI =>
    bindTools(ai, async (route, input) => {
      const tool = registeredTool(route);
      const response = await callTool(app, tool, input as Record<string, unknown>, req, testUsers);
      const text = await response.text();
      let output: unknown = text;
      try {
        output = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON: the model sees the text as it is.
      }
      return { name: tool.name, status: response.status, output, text: text || String(response.status) };
    }, describeTool);

  const roles = (user: AppUser): string[] => config.auth?.roles?.(user) ?? ((user as { roles?: string[] }).roles ?? []);

  const errorResponse = (error: unknown, headers: Headers, req: Request): Response => {
    if (error instanceof InferloError) {
      if (error.status >= 500) logger.error(`${req.method} ${new URL(req.url).pathname} failed: ${error.format()}`, error.cause ?? "");
      const body = error.toJSON();
      if (config.exposeErrors && !error.expose) (body.error as Record<string, unknown>).message = error.message;
      return json(body, error.status, headers);
    }
    logger.error(`${req.method} ${new URL(req.url).pathname} failed`, error);
    const message = config.exposeErrors && error instanceof Error ? error.message : "Internal server error";
    return json({ error: { code: "IL9000", message, docs: new InferloError("IL9000", "").docs } }, 500, headers);
  };

  const dispatch = async (req: Request, url: URL, state: Record<string, unknown>, pending: Promise<unknown>[], ip: string): Promise<Response> => {
    const headers = new Headers();
    if (cors) for (const [k, v] of Object.entries(corsHeaders(cors, req.headers.get("origin")))) headers.set(k, v);
    try {
      const method = req.method.toUpperCase();
      if (method === "OPTIONS" && cors) {
        headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        headers.set("access-control-allow-headers", (cors.headers ?? ["content-type", "authorization"]).join(", "));
        headers.set("access-control-max-age", String(cors.maxAge ?? 600));
        return new Response(null, { status: 204, headers });
      }
      if (openapiPath && url.pathname === openapiPath && method === "GET") return json(app.openapi(), 200, headers);
      if (mcpPath && url.pathname === mcpPath) return await handleMcp(app, req, headers, testUsers);

      const lookup = method === "HEAD" ? "GET" : method;
      let match: { route: CompiledRoute; values: string[] } | undefined;
      const allowed: string[] = [];
      for (const c of compiled) {
        const m = c.regex.exec(url.pathname);
        if (!m) continue;
        if (c.def.method === lookup) {
          match = { route: c, values: m.slice(1) };
          break;
        }
        allowed.push(c.def.method);
      }
      if (!match) {
        if (allowed.length) {
          headers.set("allow", [...new Set(allowed)].join(", "));
          throw new InferloError("IL2002", `${method} is not allowed on ${url.pathname}. Allowed: ${[...new Set(allowed)].join(", ")}.`, { status: 405 });
        }
        const near = suggest(url.pathname, routes.map((r) => r.path));
        throw new InferloError("IL2001", `No route matches ${method} ${url.pathname}.${near ? ` Closest route: ${near}.` : ""}`, { status: 404 });
      }
      const { def, keys } = match.route;
      const opts = def.options;

      // Auth
      let user: AppUser | null = null;
      if (testUsers.has(req)) user = testUsers.get(req) ?? null;
      else if (config.auth) user = (await config.auth.resolve(req, { db: db as never, url })) ?? null;
      const level = opts.auth ?? "user";
      if (level !== "public") {
        if (!user) throw new InferloError("IL3001", "Sign in required.", { status: 401, fix: "Send valid credentials, e.g. an Authorization: Bearer <token> header." });
        if (level !== "user" && !roles(user).includes(level)) throw new InferloError("IL3002", `This requires the "${level}" role.`, { status: 403 });
      }

      // Rate limit: counted per user (or IP without one), after auth so failed sign-ins on private routes do not use it up.
      if (opts.rateLimit) {
        const who = (opts.rateLimit.by ?? "user") === "user" && user ? `user:${user.id}` : `ip:${ip}`;
        const hit = await rateLimits.hit(`${def.method} ${def.path} ${who}`, windowMs(opts.rateLimit));
        const limited = rateLimitResult(opts.rateLimit, hit);
        for (const [k, v] of Object.entries(limited.headers)) headers.set(k, v);
        if (limited.error) throw limited.error;
      }

      // Input
      const rawParams: Record<string, string> = {};
      keys.forEach((key, i) => {
        const v = match!.values[i];
        if (v !== undefined) rawParams[key] = decodeURIComponent(v);
      });
      const params = opts.params ? parseOrThrow(opts.params, rawParams, "path parameters", true) : rawParams;
      const rawQuery = queryObject(url);
      const query = opts.query ? parseOrThrow(opts.query.strip(), rawQuery, "query string", true) : rawQuery;
      let body: unknown;
      if (opts.body) {
        const text = method === "GET" || method === "HEAD" ? "" : await readBody(req, maxBody);
        const type = req.headers.get("content-type") ?? "";
        let raw: unknown = undefined;
        if (text) {
          if (type.includes("application/x-www-form-urlencoded")) raw = Object.fromEntries(new URLSearchParams(text));
          else {
            try {
              raw = JSON.parse(text);
            } catch {
              throw new InferloError("IL2003", "Request body is not valid JSON.", { status: 400, fix: "Send JSON with Content-Type: application/json." });
            }
          }
        }
        body = parseOrThrow(opts.body, raw, "request body", type.includes("application/x-www-form-urlencoded"));
      }

      let status = 0;
      const ctx: AnyContext = {
        body,
        query,
        params,
        user,
        db: db as never,
        ai: toolsFor(req),
        jobs,
        req,
        url,
        headers: req.headers,
        state,
        status: (code: number) => void (status = code),
        header: (name: string, value: string) => headers.set(name, value),
        waitUntil: (p: Promise<unknown>) => void pending.push(p.catch((e) => logger.error("waitUntil task failed", e))),
      };
      const result = await def.handler(ctx);
      if (result instanceof Response) {
        headers.forEach((v, k) => {
          if (!result.headers.has(k)) result.headers.set(k, v);
        });
        return result;
      }
      if (result === undefined) return new Response(null, { status: status || 204, headers });
      const response = json(result, status || 200, headers);
      return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    } catch (error) {
      return errorResponse(error, headers, req);
    }
  };

  const app: App<Models> = {
    name: config.name ?? "inferlo-app",
    version: config.version ?? "0.0.0",
    routes,
    models,
    db,
    ai,
    jobs,

    async fetch(req, ...rest) {
      const url = new URL(req.url);
      const ip = clientIp(req, Boolean(config.trustProxy), rest[0]);
      if (ip !== "unknown") clientIps.set(req, ip);
      const state: Record<string, unknown> = {};
      const pending: Promise<unknown>[] = [];
      const chain = [...(config.middleware ?? [])];
      const run = (i: number): Promise<Response> => {
        const mw = chain[i];
        if (!mw) return dispatch(req, url, state, pending, ip);
        return mw({ req, url, state }, () => run(i + 1));
      };
      let response: Response;
      try {
        response = await run(0);
      } catch (error) {
        response = errorResponse(error, new Headers(), req);
      }
      if (pending.length) {
        const all = Promise.all(pending);
        const execution = rest[1] as { waitUntil?(p: Promise<unknown>): void } | undefined;
        if (execution?.waitUntil) execution.waitUntil(all);
        else void all;
      }
      return response;
    },

    async request(path, options = {}) {
      const url = new URL(path, "http://inferlo.test");
      for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = { ...options.headers };
      let body = options.body;
      if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers["content-type"] ??= "application/json";
      }
      const req = new Request(url, { method: (options.method ?? "GET").toUpperCase(), headers, body });
      if ("as" in options) testUsers.set(req, options.as ?? null);
      return app.fetch(req);
    },

    async listen(port = 3000, hostname = "0.0.0.0") {
      const { serve } = await import("./serve.ts");
      return serve(app, { port, hostname });
    },

    describe() {
      return describeApp(app, { auth: Boolean(config.auth), openapi: openapiPath, mcp: mcpPath, description: config.description });
    },

    openapi() {
      return buildOpenAPI(app, { description: config.description, auth: Boolean(config.auth) });
    },
  };
  return app;
}

function parseOrThrow(schema: AnySchema, value: unknown, where: string, coerce: boolean): unknown {
  const result = schema.safeParse(value, { coerce });
  if (!result.ok) throw new ValidationError(result.issues, where);
  return result.value;
}
