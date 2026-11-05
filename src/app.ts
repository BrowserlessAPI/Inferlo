/**
 * createApp wires models, routes, database, auth and AI together and gives you a standard
 * fetch(Request) => Response handler that runs on Node, Bun, Deno and edge runtimes.
 */
import { bindTools, createAI, type AI, type AIConfig } from "./ai/index.ts";
import { memory } from "./db/memory.ts";
import { createAudit } from "./audit.ts";
import { checkRouteCache, createCache, databaseCacheStore, etagFor, etagMatches, memoryCacheStore, resolveCacheConfig, routeCacheKey, type Cache, type CacheConfig, type CachedResponse } from "./cache.ts";
import { bindDb, createDb, guardAdapter, type Db } from "./db/table.ts";
import type { Adapter } from "./db/types.ts";
import { describeApp, type AppDescription } from "./describe.ts";
import { InferloError, didYouMean, suggest } from "./errors.ts";
import { callTool, handleMcp, toolDefinition } from "./mcp.ts";
import type { AnyModel } from "./model.ts";
import { buildOpenAPI } from "./openapi.ts";
import { collectRoutes, type AnyContext, type AppDb, type AppUser, type Method, type RouteDef } from "./route.ts";
import { checkRateLimit, databaseRateLimitStore, memoryRateLimitStore, rateLimitResult, windowMs, type RateLimitConfig, type RateLimitStore } from "./rate-limit.ts";
import { clientIp, clientIps } from "./client-ip.ts";
import { collectCrons, collectJobs, createJobs, jobStoreFor, stopWorkers, type AppJobs, type JobQueueConfig, type JobSource } from "./jobs.ts";
import type { Server } from "./serve.ts";
import { ValidationError, type AnySchema } from "./schema.ts";
import { createRedactor, redactingLogger, redactValues, secretsOf } from "./redact.ts";
import { defaultLogger, loggingOptions, REQUEST_ID, type LogFields, type LoggingConfig } from "./logging.ts";
import { resolveDeprecation, type ResolvedDeprecation } from "./deprecation.ts";
import { createMetrics, hasMetricsToken, resolveMetrics, type AppMetrics, type MetricsConfig } from "./metrics.ts";
import { INFERLO_VERSION } from "./describe.ts";
import { registerRequestMatcher } from "./request-matcher.ts";
import { versionDocPath, versionsOf } from "./api-version.ts";
import { resolveModules, type AnyModule, type ModuleInfo, type ModuleModels } from "./module.ts";
import { isPermissions, type Permissions } from "./permissions.ts";
import { applySecureHeaders, resolveSecureHeaders, type SecureHeadersConfig } from "./secure-headers.ts";

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
  /** This request's id, sent back in the X-Request-Id header and added to its log entries. */
  requestId: string;
}
export type Middleware = (ctx: MiddlewareContext, next: () => Promise<Response>) => Promise<Response>;

/**
 * Where the app writes logs. fields holds structured values such as requestId (a request's log entries)
 * or method, path, status and durationMs (request logs); loggers that only take two arguments ignore them.
 */
export interface Logger {
  info(message: string, data?: unknown, fields?: LogFields): void;
  error(message: string, data?: unknown, fields?: LogFields): void;
}

/** A readiness check: resolve (or return) when the dependency is usable, throw when it is not. */
export type HealthCheck = () => unknown | Promise<unknown>;

export interface HealthConfig {
  /** Liveness endpoint: 200 while the process can answer requests. Default "/health". */
  path?: string;
  /** Readiness endpoint: 200 when every check passes, 503 otherwise. Default "/ready". */
  readyPath?: string;
  /** Your own checks, by name ("database" and "ai" are built in): { redis: () => redis.ping() }. */
  checks?: Record<string, HealthCheck>;
  /** Time each check may take before it fails. Default 5000 ms. */
  timeoutMs?: number;
}

export interface CheckResult {
  status: "ok" | "error";
  durationMs: number;
  /** "Check failed." unless the check threw an exposed InferloError (httpError) or exposeErrors is on. */
  error?: string;
}

export interface CloseOptions {
  /**
   * Keep serving requests for this long after /ready starts answering 503, so load balancers stop sending
   * traffic first (for example a few seconds more than the readiness probe period). Default 0.
   */
  delayMs?: number;
  /** Longest wait for in-flight requests, waitUntil tasks and the running job before closing anyway. Default 10000. */
  timeoutMs?: number;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: Record<string, CheckResult>;
}

/** Anything that contains routes: a route, an array, or a module (import * as tickets from "./routes/tickets.ts"). */
export type RouteSource = RouteDef | readonly RouteSource[] | { readonly [name: string]: unknown };

export interface AppConfig<Models extends readonly AnyModel[], Modules extends readonly AnyModule[] = readonly AnyModule[]> {
  /** Shown in OpenAPI, MCP and describe. */
  name?: string;
  version?: string;
  description?: string;
  models?: Models;
  /**
   * Feature modules from module("billing", { imports, models, routes, jobs, provides }). Their models, routes
   * and jobs join the app's own; every module a module imports must be listed here too.
   */
  modules?: Modules;
  routes?: RouteSource[];
  /** Background jobs and crons: jobs, cron(schedule, job) values, arrays or modules (import * as jobs from "./jobs.ts"). */
  jobs?: JobSource[];
  /** Where queued jobs are kept: { store: "memory" } (default) or { store: "database" } (Postgres table inferlo_jobs, shared by every instance). */
  jobQueue?: JobQueueConfig;
  /** Where ctx.cache and app.cache keep entries: { store: "memory" } (default) or { store: "database" } (Postgres table inferlo_cache, shared by every instance). */
  cache?: CacheConfig;
  /** Database adapter. Default: memory(). Use postgres() from "@browserlessapi/inferlo/postgres" in production. */
  db?: Adapter;
  auth?: AuthConfig;
  /** Named permissions from permissions({ ... }), required when a route sets permission. */
  permissions?: Permissions<any>;
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
  /**
   * Health endpoints for load balancers and orchestrators: GET /health (liveness) and GET /ready (readiness:
   * the database, the AI configuration and your checks). Public, never cached. Off by default.
   */
  health?: boolean | HealthConfig;
  /**
   * Security headers sent on every response that does not set them itself: Content-Security-Policy,
   * Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy, Referrer-Policy, X-Content-Type-Options,
   * X-Frame-Options, and Strict-Transport-Security over HTTPS. Change one by name, false leaves it out:
   * { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": false }. false sends none. Default true.
   */
  secureHeaders?: boolean | SecureHeadersConfig;
  /**
   * Longest time in milliseconds a route may take (reading the body and running the handler) before it answers
   * 503 IL2007 and ctx.signal is aborted. Routes can set their own timeoutMs. false turns it off. Default 60000.
   */
  requestTimeoutMs?: number | false;
  /**
   * More values to hide from logs, besides credentials Inferlo finds itself (authorization and cookie headers,
   * tokens, API keys, passwords in URLs) and the AI provider keys: your config() result (its secrets) or
   * strings: redact: [settings, process.env.WEBHOOK_SECRET]. They are replaced with "[redacted]".
   */
  redact?: readonly (string | object | undefined | null)[];
  /** Include error messages of unexpected (500) errors in responses. Default false. */
  exposeErrors?: boolean;
  /** Your own logger (for example pino or winston): { info(message, data, fields), error(message, data, fields) }. */
  logger?: Logger;
  /**
   * The built-in logger's format ("text" or "json", one object per line) and request logs (requests: true logs
   * each request's id, method, path, status and duration). Every response has an X-Request-Id header.
   */
  logging?: LoggingConfig;
  /**
   * Prometheus metrics at GET /metrics: requests by route and status with durations, job runs, and AI calls,
   * tokens and cost per alias. { token } requires Authorization: Bearer <token>; without it the endpoint is
   * public, so keep it off the internet. Off by default.
   */
  metrics?: boolean | MetricsConfig;
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
  /** Every model: createApp({ models }) and then the models of each module. */
  readonly models: Models;
  /** The feature modules from createApp({ modules }). */
  readonly modules: readonly AnyModule[];
  readonly db: Db<Models>;
  readonly ai: AI;
  /** Background jobs: app.jobs.enqueue(job, input), app.jobs.start() to run them, app.jobs.runDue() in tests. */
  readonly jobs: AppJobs;
  /** The app cache, the same as ctx.cache: await app.cache.getOrSet(key, { ttlMs, tags }, compute), app.cache.invalidate(tag). */
  readonly cache: Cache;
  /** Standard fetch handler: export default app works on Bun, Deno and Cloudflare Workers. */
  fetch(req: Request, ...rest: unknown[]): Promise<Response>;
  /** In-process request for tests: await app.request("/tickets", { method: "POST", json: {...}, as: user }). */
  request(path: string, options?: RequestOptions): Promise<Response>;
  /** Start an HTTP server (Node, Bun or Deno). */
  listen(port?: number, hostname?: string): Promise<{ port: number; close(): Promise<void> }>;
  /** Run the readiness checks (the same report as GET /ready, also when health is off). */
  checkReady(): Promise<ReadinessReport>;
  /** True once app.close() was called: /ready answers 503. */
  readonly closing: boolean;
  /**
   * Graceful shutdown, for SIGTERM: /ready answers 503, then (after delayMs) new requests get 503 IL2006,
   * in-flight requests, waitUntil tasks and the job workers from app.jobs.start() finish (up to timeoutMs),
   * servers from app.listen() close, then the database. Calling it again returns the same promise.
   */
  close(options?: CloseOptions): Promise<void>;
  /** Machine-readable map of the whole app: routes, models, auth and AI. */
  describe(): AppDescription;
  /** The OpenAPI 3.1 document: every route, or with { version: "v1" } the routes of apiVersion("v1", ...) and the routes outside every version. */
  openapi(options?: { version?: string }): Record<string, unknown>;
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


function corsHeaders(config: CorsConfig, origin: string | null): Record<string, string> {
  const allowed = config.origin === "*" ? "*" : origin && (Array.isArray(config.origin) ? config.origin : [config.origin]).includes(origin) ? origin : null;
  if (!allowed) return {};
  const h: Record<string, string> = { "access-control-allow-origin": allowed, vary: "origin" };
  if (config.credentials) h["access-control-allow-credentials"] = "true";
  return h;
}

async function readBody(req: Request, limit: number, signal?: AbortSignal): Promise<string> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > limit) throw new InferloError("IL2004", `Request body is larger than ${limit} bytes.`, { status: 413 });
  if (!req.body) return "";
  const reader = req.body.getReader();
  // Stop reading a slow body once the request timed out.
  signal?.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
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

/** Sets a header unless the response already has it; copies responses with immutable headers. */
function withHeader(response: Response, name: string, value: string): Response {
  if (response.headers.has(name)) return response;
  try {
    response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(name, value);
    return copy;
  }
}

function json(data: unknown, status: number, headers: Headers): Response {
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export function createApp<const Models extends readonly AnyModel[] = [], const Modules extends readonly AnyModule[] = []>(
  config: AppConfig<Models, Modules> = {},
): App<[...Models, ...ModuleModels<Modules>]> {
  // Everything the app logs goes through the redactor: credentials and secrets never reach the logs.
  const redactor = createRedactor([...redactValues(config.redact), ...Object.values(config.ai?.providers ?? {}).flatMap((p) => secretsOf(p))]);
  const logging = loggingOptions(config.logging, config.logger !== undefined);
  const logger: Logger = redactingLogger(config.logger ?? defaultLogger(logging.format, config.name ?? "inferlo-app"), redactor);
  const { modules, modelOwner } = resolveModules(config.modules, config.models ?? []);
  const models = [...(config.models ?? []), ...modules.flatMap((m) => m.models)] as unknown as [...Models, ...ModuleModels<Modules>];
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

  // Routes of the app itself, then each module's; routeModule remembers which module a route came from.
  const routeModule = new Map<RouteDef, string>();
  const routes = collectRoutes(config.routes);
  for (const m of modules) {
    for (const r of collectRoutes(m.routes as RouteSource[])) {
      routeModule.set(r, m.name);
      routes.push(r);
    }
  }
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

  if (config.permissions !== undefined && !isPermissions(config.permissions)) {
    throw new InferloError("IL6026", "createApp({ permissions }) takes the result of permissions({ ... }).", { fix: 'Define them with permissions({ "tickets.update": ({ user, ticket }) => ticket.ownerId === user.id }) and pass that value.' });
  }
  for (const r of routes) {
    const name = r.options.permission;
    if (name === undefined) continue;
    const where = `${r.method} ${r.path}`;
    if (typeof name !== "string" || !config.permissions?.has(name)) {
      throw new InferloError("IL6026", config.permissions ? `The route ${where} uses the unknown permission "${String(name)}".` : `The route ${where} uses the permission "${String(name)}", but createApp has no permissions.`, {
        fix: config.permissions ? `Use one of: ${config.permissions.list.map((p) => p.name).join(", ")}, or add it to permissions({ ... }).` : "Pass createApp({ permissions }) with the value from permissions({ ... }).",
      });
    }
    if (r.options.auth === "public") {
      throw new InferloError("IL6026", `The route ${where} has a permission but auth: "public".`, { fix: 'A permission needs a signed-in user: remove auth: "public" from the route.' });
    }
  }

  for (const r of routes) if (r.options.rateLimit !== undefined) checkRateLimit(r.options.rateLimit, `${r.method} ${r.path}`);
  for (const r of routes) if (r.options.cache !== undefined) checkRouteCache(r.options.cache, r.method, `${r.method} ${r.path}`);
  const requestTimeoutMs = config.requestTimeoutMs === undefined ? 60_000 : checkTimeout(config.requestTimeoutMs, "createApp({ requestTimeoutMs })");
  for (const r of routes) if (r.options.timeoutMs !== undefined) checkTimeout(r.options.timeoutMs, `${r.method} ${r.path} { timeoutMs }`);
  const deprecations = new Map<RouteDef, ResolvedDeprecation>();
  for (const r of routes) {
    const resolved = resolveDeprecation(r.options.deprecated, `${r.method} ${r.path}`);
    if (resolved) deprecations.set(r, resolved);
  }
  const storeName = config.rateLimit?.store ?? "memory";
  if (storeName !== "memory" && storeName !== "database") {
    throw new InferloError("IL6007", `Invalid rateLimit store "${String(storeName)}".`, { fix: 'Use createApp({ rateLimit: { store: "memory" } }) or { store: "database" }.' });
  }

  const openapiPath = config.openapi === undefined ? "/openapi.json" : config.openapi;
  const hasTools = routes.some((r) => r.options.tool);
  const mcpPath = config.mcp === undefined ? (hasTools ? "/mcp" : false) : config.mcp;
  const health = resolveHealth(config.health, routes, [openapiPath, mcpPath]);
  // apiVersion("v1", ...) routes get their own OpenAPI document at /v1/openapi.json.
  const versions = versionsOf(routes);
  const versionDocs = new Map<string, string>(openapiPath ? versions.map((v) => [versionDocPath(v, openapiPath), v]) : []);
  for (const docPath of versionDocs.keys()) {
    const clash = routes.find((r) => r.method === "GET" && r.path.replace(/\/+$/, "") === docPath);
    if (clash) throw new InferloError("IL6025", `The route GET ${clash.path} has the path of the OpenAPI document of API version ${versionDocs.get(docPath)}.`, { fix: "Rename the route; Inferlo serves each version's OpenAPI document there." });
  }
  const metricsConfig = resolveMetrics(config.metrics, [
    ...[...versionDocs.keys()].map((path) => ({ path, what: "an OpenAPI document path" })),
    { path: openapiPath, what: "the OpenAPI path" },
    { path: mcpPath, what: "the MCP path" },
    { path: health?.path ?? false, what: "the health path" },
    { path: health?.readyPath ?? false, what: "the readiness path" },
    ...routes.filter((r) => r.method === "GET").map((r) => ({ path: r.path, what: `the route GET ${r.path}` })),
  ]);
  const adapter = config.db ?? memory();
  const db = createDb(models, adapter);
  const rateLimits: RateLimitStore = storeName === "database" ? databaseRateLimitStore(adapter) : memoryRateLimitStore();
  const cacheConfig = resolveCacheConfig(config.cache);
  const cache = createCache(cacheConfig.store === "database" ? databaseCacheStore(adapter) : memoryCacheStore(cacheConfig.maxEntries), cacheConfig.store);
  const metrics: AppMetrics | undefined = metricsConfig
    ? createMetrics({ app: config.name ?? "inferlo-app", version: config.version ?? "0.0.0", inferlo: INFERLO_VERSION }, metricsConfig.buckets)
    : undefined;
  // With metrics on, every AI call that reports usage is counted before the app's own onUsage runs.
  const aiConfig: AIConfig | undefined = metrics && config.ai
    ? { ...config.ai, onUsage: (usage) => (metrics.ai(usage), config.ai!.onUsage?.(usage)) }
    : config.ai;
  const ai = createAI(aiConfig);
  const jobModule = new Map<string, string>();
  for (const m of modules) for (const j of collectJobs(m.jobs)) jobModule.set(j.name, m.name);
  const moduleInfo: ModuleInfo = { modules, routeModule, modelOwner, jobModule };
  const jobSources: JobSource[] = [...(config.jobs ?? []), ...modules.flatMap((m) => m.jobs)];
  const jobs = createJobs(
    collectJobs(jobSources),
    {
      db: db as never,
      ai,
      cache,
      audit: (run) => createAudit(models, redactor, () => db as never, { userId: null, source: `job ${run.name}` }),
      store: jobStoreFor(config.jobQueue, adapter),
      queue: config.jobQueue?.store ?? "memory",
      logger,
      onRun: metrics ? (name, outcome, ms) => metrics.job(name, outcome, ms / 1000) : undefined,
    },
    collectCrons(jobSources),
  );
  const maxBody = config.maxBodySize ?? 1024 * 1024;
  const secureHeaders = resolveSecureHeaders(config.secureHeaders);
  const cors: CorsConfig | undefined = config.cors === true ? { origin: "*" } : config.cors || undefined;

  // Readiness: the database answers, every AI alias points to a configured provider, and the app's own checks pass.
  const readinessChecks: Record<string, HealthCheck> = {
    database: async () => {
      if (adapter.sql) await adapter.sql("select 1");
    },
  };
  const aiProviders = Object.keys(config.ai?.providers ?? {});
  if (aiProviders.length || Object.keys(config.ai?.models ?? {}).length) {
    readinessChecks.ai = () => {
      for (const [alias, targets] of Object.entries(ai.aliases)) {
        for (const target of targets) {
          const provider = target.split(":")[0]!;
          if (!aiProviders.includes(provider)) {
            throw new InferloError("IL5001", `AI alias "${alias}" uses provider "${provider}", which is not configured.`, { status: 503, expose: true });
          }
        }
      }
    };
  }
  Object.assign(readinessChecks, health?.checks);
  const runCheck = async (name: string, check: HealthCheck): Promise<CheckResult> => {
    const started = Date.now();
    const timeoutMs = health?.timeoutMs ?? 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("timeout");
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(check),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(timedOut), timeoutMs);
        }),
      ]);
      if (outcome === timedOut) {
        logger.error(`Readiness check "${name}" timed out after ${timeoutMs} ms`);
        return { status: "error", durationMs: Date.now() - started, error: `Timed out after ${timeoutMs} ms.` };
      }
      return { status: "ok", durationMs: Date.now() - started };
    } catch (error) {
      logger.error(`Readiness check "${name}" failed`, error);
      const shown = (error instanceof InferloError && error.expose) || (config.exposeErrors && error instanceof Error);
      return { status: "error", durationMs: Date.now() - started, error: shown ? redactor.text((error as Error).message) : "Check failed." };
    } finally {
      clearTimeout(timer);
    }
  };

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
  const toolsFor = (req: Request, signal: AbortSignal): AI =>
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
    }, describeTool, signal);

  const roles = (user: AppUser): string[] => config.auth?.roles?.(user) ?? ((user as { roles?: string[] }).roles ?? []);

  const errorResponse = (error: unknown, headers: Headers, req: Request, requestId: string): Response => {
    const fields = { requestId };
    if (error instanceof InferloError) {
      if (error.status >= 500) logger.error(`${req.method} ${new URL(req.url).pathname} failed: ${error.format()}`, error.cause ?? "", fields);
      const body = error.toJSON();
      if (config.exposeErrors && !error.expose) (body.error as Record<string, unknown>).message = redactor.text(error.message);
      return json(body, error.status, headers);
    }
    logger.error(`${req.method} ${new URL(req.url).pathname} failed`, error, fields);
    const message = config.exposeErrors && error instanceof Error ? redactor.text(error.message) : "Internal server error";
    return json({ error: { code: "IL9000", message, docs: new InferloError("IL9000", "").docs } }, 500, headers);
  };

  const dispatch = async (req: Request, url: URL, state: Record<string, unknown>, pending: Promise<unknown>[], ip: string, requestId: string, seen: { route: string }): Promise<Response> => {
    const headers = new Headers();
    if (cors) for (const [k, v] of Object.entries(corsHeaders(cors, req.headers.get("origin")))) headers.set(k, v);
    try {
      const method = req.method.toUpperCase();
      if (method === "OPTIONS" && cors) {
        headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        headers.set("access-control-allow-headers", (cors.headers ?? ["content-type", "authorization", "x-csrf-token"]).join(", "));
        headers.set("access-control-max-age", String(cors.maxAge ?? 600));
        return new Response(null, { status: 204, headers });
      }
      if (health && (method === "GET" || method === "HEAD") && (url.pathname === health.path || url.pathname === health.readyPath)) {
        headers.set("cache-control", "no-store");
        const report = url.pathname === health.path ? { status: "ok" } : await app.checkReady();
        const response = json(report, report.status === "not_ready" ? 503 : 200, headers);
        return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }
      if (metricsConfig && url.pathname === metricsConfig.path && (method === "GET" || method === "HEAD")) {
        headers.set("cache-control", "no-store");
        if (metricsConfig.token && !hasMetricsToken(req, metricsConfig.token)) {
          headers.set("www-authenticate", 'Bearer realm="metrics"');
          throw new InferloError("IL3001", "Sign in required.", { status: 401, fix: "Send the metrics token as Authorization: Bearer <token> (bearer_token in the Prometheus scrape config)." });
        }
        headers.set("content-type", "text/plain; version=0.0.4; charset=utf-8");
        return new Response(method === "HEAD" ? null : metrics!.render(), { status: 200, headers });
      }
      if (refusing) {
        headers.set("connection", "close");
        throw new InferloError("IL2006", "The server is shutting down.", { status: 503, fix: "Retry the request; another instance will answer it." });
      }
      if (method === "GET" && versionDocs.has(url.pathname)) {
        seen.route = url.pathname;
        return json(app.openapi({ version: versionDocs.get(url.pathname)! }), 200, headers);
      }
      if (openapiPath && url.pathname === openapiPath && method === "GET") {
        seen.route = openapiPath;
        return json(app.openapi(), 200, headers);
      }
      if (mcpPath && url.pathname === mcpPath) {
        seen.route = mcpPath;
        // tools/list leaves out tools that need a role or permission the caller does not have.
        let caller: Promise<AppUser | null> | undefined;
        const visible = async (def: RouteDef): Promise<boolean> => {
          const level = def.options.auth ?? "user";
          if (!def.options.permission && (level === "public" || level === "user")) return true;
          caller ??= testUsers.has(req) ? Promise.resolve(testUsers.get(req) ?? null) : config.auth ? Promise.resolve(config.auth.resolve(req, { db: db as never, url })).then((u) => u ?? null) : Promise.resolve(null);
          const user = await caller;
          if (!user) return false;
          if (level !== "public" && level !== "user" && !roles(user).includes(level)) return false;
          if (!def.options.permission) return true;
          return config.permissions!.can(def.options.permission, { user }).catch(() => false);
        };
        return await handleMcp(app, req, headers, testUsers, visible);
      }

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
      seen.route = def.path;
      // Deprecation headers go on every answer of the route, errors included.
      for (const [name, value] of deprecations.get(def)?.headers ?? []) headers.set(name, value);
      const opts = def.options;
      const limit = opts.timeoutMs === undefined ? requestTimeoutMs : opts.timeoutMs;
      // timeout aborts when the route takes too long; signal (ctx.signal) also when the client disconnects.
      const timeout = new AbortController();
      const signal = AbortSignal.any([req.signal, timeout.signal]);
      let requestDb: Db<Models> | undefined;
      const run = async (): Promise<Response> => {
        // Auth
        let user: AppUser | null = null;
        if (testUsers.has(req)) user = testUsers.get(req) ?? null;
        else if (config.auth) user = (await config.auth.resolve(req, { db: db as never, url })) ?? null;
        const level = opts.auth ?? "user";
        if (level !== "public") {
          if (!user) throw new InferloError("IL3001", "Sign in required.", { status: 401, fix: "Send valid credentials, e.g. an Authorization: Bearer <token> header." });
          if (level !== "user" && !roles(user).includes(level)) throw new InferloError("IL3002", `This requires the "${level}" role.`, { status: 403 });
        }
        if (opts.permission) await config.permissions!.authorize(opts.permission, { user });

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
          const text = method === "GET" || method === "HEAD" ? "" : await readBody(req, maxBody, timeout.signal);
          const type = req.headers.get("content-type") ?? "";
          let raw: unknown = undefined;
          if (text) {
            if (type.includes("application/x-www-form-urlencoded")) {
              // _csrf is the sessions() CSRF field of HTML forms, checked before the handler and not part of the body.
              const form = new URLSearchParams(text);
              form.delete("_csrf");
              raw = Object.fromEntries(form);
            }
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

        // Response cache: after auth, permissions, rate limits and input checks, so a cached response is only
        // served to callers who may call the route with valid input.
        const routeCache = opts.cache;
        const cacheKey = routeCache ? await routeCacheKey(def.method, def.path, routeCache, user?.id, url) : undefined;
        const cacheHeaders = (outcome: "HIT" | "MISS", etag: string) => {
          headers.set("x-inferlo-cache", outcome);
          headers.set("etag", etag);
          if (!headers.has("cache-control")) headers.set("cache-control", `${(routeCache!.by ?? "user") === "public" && (opts.auth ?? "user") === "public" ? "public" : "private"}, no-cache`);
          if ((routeCache!.by ?? "user") === "user") headers.append("vary", "Authorization, Cookie");
        };
        const cachedAnswer = (body: string, etag: string): Response => {
          if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
          headers.set("content-type", "application/json; charset=utf-8");
          return new Response(method === "HEAD" ? null : body, { status: 200, headers });
        };
        if (cacheKey) {
          const hit = await cache.get<CachedResponse>(cacheKey);
          if (hit) {
            for (const [name, value] of hit.headers) headers.set(name, value);
            cacheHeaders("HIT", hit.etag);
            return cachedAnswer(JSON.stringify(hit.body), hit.etag);
          }
        }
        const handlerHeaders: [string, string][] = [];

        let status = 0;
        const ctx: AnyContext = {
          body,
          query,
          params,
          user,
          get db() {
            // Built on first use: after a timeout, new queries fail with IL2007 instead of running.
            return (requestDb ??= bindDb(models, guardAdapter(adapter, timeout.signal))) as never;
          },
          ai: toolsFor(req, signal),
          signal,
          requestId,
          jobs,
          cache,
          req,
          url,
          headers: req.headers,
          state,
          status: (code: number) => void (status = code),
          header: (name: string, value: string) => {
            // Set-Cookie is added, not replaced, so a handler can set several cookies.
            if (name.toLowerCase() === "set-cookie") headers.append(name, value);
            else headers.set(name, value);
            handlerHeaders.push([name.toLowerCase(), value]);
          },
          waitUntil: (p: Promise<unknown>) => void pending.push(p.catch((e) => logger.error("waitUntil task failed", e, { requestId }))),
          audit: createAudit(models, redactor, () => ctx.db as never, { userId: user?.id ?? null, source: `${def.method} ${def.path}`, requestId }),
        };
        const result = await def.handler(ctx);
        if (result instanceof Response) {
          headers.forEach((v, k) => {
            if (k !== "set-cookie" && !result.headers.has(k)) result.headers.set(k, v);
          });
          for (const cookie of headers.getSetCookie()) result.headers.append("set-cookie", cookie);
          return result;
        }
        if (result === undefined) return new Response(null, { status: status || 204, headers });
        // Only plain 200 JSON answers are cached, never one that sets a cookie.
        if (cacheKey && (status || 200) === 200 && !handlerHeaders.some(([name]) => name === "set-cookie")) {
          const body = JSON.stringify(result);
          const etag = await etagFor(body);
          await cache.set(cacheKey, { body: JSON.parse(body), headers: handlerHeaders, etag } satisfies CachedResponse, { ttlMs: routeCache!.ttlMs, tags: routeCache!.tags ?? [] });
          cacheHeaders("MISS", etag);
          return cachedAnswer(body, etag);
        }
        const response = json(result, status || 200, headers);
        return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      };
      if (limit === false) return await run();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const running = run();
      // After a timeout the handler keeps running; its later result or error is dropped.
      running.catch(() => {});
      try {
        return await Promise.race([
          running,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new InferloError("IL2007", `The request took longer than ${limit} ms.`, {
                status: 503,
                expose: true,
                fix: `Make the handler faster or move slow work to a background job; raise the route's timeoutMs or createApp({ requestTimeoutMs }) if it needs more time.`,
              });
              timeout.abort(error);
              reject(error);
            }, limit);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return errorResponse(error, headers, req, requestId);
    }
  };

  // Shutdown state: closing makes /ready answer 503, refusing (after delayMs) answers new requests with 503.
  let closing = false;
  let refusing = false;
  let closed: Promise<void> | undefined;
  let inFlight = 0;
  const tasks = new Set<Promise<unknown>>();
  const servers = new Set<Server>();
  let idle: (() => void)[] = [];
  const settle = () => {
    if (inFlight > 0 || tasks.size > 0) return;
    for (const resolve of idle) resolve();
    idle = [];
  };
  const whenIdle = () => new Promise<void>((resolve) => {
    idle.push(resolve);
    settle();
  });
  /** Resolves true when promise settled before ms passed, false otherwise. */
  const within = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  };

  async function handle(req: Request, rest: unknown[]): Promise<Response> {
    const started = performance.now();
    const url = new URL(req.url);
    // Behind a trusted proxy, keep the id it sent so log entries line up across services.
    const incoming = config.trustProxy ? req.headers.get("x-request-id") : null;
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    const ip = clientIp(req, Boolean(config.trustProxy), rest[0]);
    if (ip !== "unknown") clientIps.set(req, ip);
    const state: Record<string, unknown> = {};
    const pending: Promise<unknown>[] = [];
    const chain = [...(config.middleware ?? [])];
    // The matched route pattern, for metrics ("unmatched" for 404s and responses from middleware).
    const seen = { route: "unmatched" };
    const run = (i: number): Promise<Response> => {
      const mw = chain[i];
      if (!mw) return dispatch(req, url, state, pending, ip, requestId, seen);
      return mw({ req, url, state, requestId }, () => run(i + 1));
    };
    let response: Response;
    try {
      response = await run(0);
    } catch (error) {
      response = errorResponse(error, new Headers(), req, requestId);
    }
    response = withHeader(response, "x-request-id", requestId);
    // Health and metrics endpoints are called every few seconds by load balancers and scrapers: not logged or counted.
    const probe = url.pathname === health?.path || url.pathname === health?.readyPath || url.pathname === metricsConfig?.path;
    if (!probe) {
      const elapsed = performance.now() - started;
      const method = req.method.toUpperCase();
      metrics?.request(method, seen.route, response.status, elapsed / 1000);
      if (logging.requests) {
        const durationMs = Math.round(elapsed * 10) / 10;
        logger.info(`${method} ${url.pathname} ${response.status} ${durationMs}ms`, undefined, { requestId, method, path: url.pathname, status: response.status, durationMs });
      }
    }
    if (secureHeaders.length) {
      const https = url.protocol === "https:" || (Boolean(config.trustProxy) && req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https");
      response = applySecureHeaders(response, secureHeaders, https);
    }
    if (pending.length) {
      const all = Promise.all(pending);
      const execution = rest[1] as { waitUntil?(p: Promise<unknown>): void } | undefined;
      if (execution?.waitUntil) execution.waitUntil(all);
      else {
        // Kept until it settles, so app.close() waits for it.
        tasks.add(all);
        void all.finally(() => {
          tasks.delete(all);
          settle();
        });
      }
    }
    return response;
  }

  const app: App<[...Models, ...ModuleModels<Modules>]> = {
    name: config.name ?? "inferlo-app",
    version: config.version ?? "0.0.0",
    routes,
    models,
    modules,
    db,
    ai,
    jobs,
    cache,

    get closing() {
      return closing;
    },

    async fetch(req, ...rest) {
      inFlight++;
      metrics?.inFlight(1);
      try {
        return await handle(req, rest);
      } finally {
        inFlight--;
        metrics?.inFlight(-1);
        settle();
      }
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
      const server = await serve(app, { port, hostname });
      servers.add(server);
      return {
        port: server.port,
        close: async () => {
          servers.delete(server);
          await server.close();
        },
      };
    },

    async checkReady() {
      if (closing) return { status: "not_ready", checks: { shutdown: { status: "error", durationMs: 0, error: "The app is shutting down." } } };
      const names = Object.keys(readinessChecks);
      const results = await Promise.all(names.map((name) => runCheck(name, readinessChecks[name]!)));
      const checks: Record<string, CheckResult> = {};
      names.forEach((name, i) => (checks[name] = results[i]!));
      return { status: results.every((r) => r.status === "ok") ? "ready" : "not_ready", checks };
    },

    close(options = {}) {
      if (closed) return closed;
      const delayMs = options.delayMs ?? 0;
      const timeoutMs = options.timeoutMs ?? 10_000;
      for (const [key, value] of [["delayMs", delayMs], ["timeoutMs", timeoutMs]] as const) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new InferloError("IL6015", `app.close({ ${key} }) must be a number of milliseconds of 0 or more, got ${String(value)}.`, {
            fix: "Use app.close({ delayMs: 5000, timeoutMs: 10000 }) or app.close().",
          });
        }
      }
      closing = true;
      closed = (async () => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        refusing = true;
        const deadline = Date.now() + timeoutMs;
        let workersStopped = false;
        const drained = Promise.all([whenIdle(), stopWorkers(jobs).then(() => void (workersStopped = true))]);
        if (!(await within(drained, timeoutMs))) {
          const left = [`${inFlight} request(s)`, `${tasks.size} waitUntil task(s)`];
          if (!workersStopped) left.push("the running job");
          logger.error(`app.close(): stopped waiting after ${timeoutMs} ms with ${left.join(", ")} still running`);
        }
        const { forceClosers } = servers.size ? await import("./serve.ts") : { forceClosers: undefined };
        await Promise.all([...servers].map(async (server) => {
          servers.delete(server);
          if (!(await within(server.close(), Math.max(0, deadline - Date.now())))) forceClosers?.get(server)?.();
        }));
        await db.$close();
      })();
      return closed;
    },

    describe() {
      return describeApp(app, {
        auth: Boolean(config.auth),
        openapi: openapiPath,
        mcp: mcpPath,
        health: health?.path ?? false,
        ready: health?.readyPath ?? false,
        metrics: metricsConfig?.path ?? false,
        secureHeaders: secureHeaders.map(([name]) => name),
        requestTimeoutMs,
        logging: { format: config.logger ? "custom" : logging.format, requests: logging.requests },
        description: config.description,
        modules: moduleInfo,
        versions: versions.map((v) => ({ name: v, openapi: openapiPath ? versionDocPath(v, openapiPath) : false })),
        permissions: config.permissions?.list.map((p) => (p.roles ? { name: p.name, roles: [...p.roles] } : { name: p.name })) ?? [],
      });
    },

    openapi(options = {}) {
      if (options.version !== undefined && !versions.includes(options.version)) {
        throw new InferloError("IL6025", `The app has no API version ${JSON.stringify(options.version)}.${versions.length ? ` Its versions: ${versions.join(", ")}.` : " It has no apiVersion() routes."}`, {
          fix: 'Pass a version used in apiVersion("v1", routes), or call app.openapi() for every route.',
        });
      }
      return buildOpenAPI(app, { description: config.description, auth: Boolean(config.auth), modules: moduleInfo, version: options.version });
    },
  };
  // Built-in endpoints with the methods dispatch answers them for (MCP takes every method).
  const readEndpoints = [health?.path, health?.readyPath, metricsConfig?.path].filter((p): p is string => typeof p === "string");
  registerRequestMatcher(app, (rawMethod, pathname) => {
    const method = rawMethod.toUpperCase();
    if (mcpPath && pathname === mcpPath) return true;
    if (method === "GET" && ((openapiPath && pathname === openapiPath) || versionDocs.has(pathname))) return true;
    if ((method === "GET" || method === "HEAD") && readEndpoints.includes(pathname)) return true;
    const lookup = method === "HEAD" ? "GET" : method;
    // A CORS preflight belongs to the app when any of its routes has this path.
    return compiled.some((c) => (method === "OPTIONS" || c.def.method === lookup) && c.regex.test(pathname));
  });
  return app;
}

function resolveHealth(option: AppConfig<any>["health"], routes: RouteDef[], taken: (string | false)[]): (Required<Omit<HealthConfig, "checks">> & { checks: Record<string, HealthCheck> }) | undefined {
  if (option === undefined || option === false) return undefined;
  const bad = (message: string, fix: string) => new InferloError("IL6014", message, { fix });
  if (option !== true && (typeof option !== "object" || option === null)) throw bad("health must be true or an object.", "Use createApp({ health: true }) or createApp({ health: { checks: { ... } } }).");
  const o: HealthConfig = option === true ? {} : option;
  const resolved = { path: o.path ?? "/health", readyPath: o.readyPath ?? "/ready", timeoutMs: o.timeoutMs ?? 5000, checks: o.checks ?? {} };
  for (const [key, value] of [["path", resolved.path], ["readyPath", resolved.readyPath]] as const) {
    if (typeof value !== "string" || !value.startsWith("/")) throw bad(`health.${key} must be a path starting with "/", got ${JSON.stringify(value)}.`, `Use health: { ${key}: "/${String(value).replace(/^\/+/, "")}" }.`);
  }
  if (resolved.path === resolved.readyPath) throw bad(`health.path and health.readyPath are both "${resolved.path}".`, 'Use different paths, for example "/health" and "/ready".');
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs <= 0) throw bad(`health.timeoutMs must be a positive number of milliseconds, got ${String(resolved.timeoutMs)}.`, "Use health: { timeoutMs: 5000 }.");
  if (typeof resolved.checks !== "object" || resolved.checks === null) throw bad("health.checks must be an object of functions.", "Use health: { checks: { redis: () => redis.ping() } }.");
  for (const [name, check] of Object.entries(resolved.checks)) {
    if (name === "database" || name === "ai") throw bad(`health.checks.${name} is built in.`, `Give your check another name, for example "${name}Replica".`);
    if (typeof check !== "function") throw bad(`health.checks.${name} must be a function.`, `Use health: { checks: { ${name}: async () => { ... } } }; throw when it is not ready.`);
  }
  for (const path of [resolved.path, resolved.readyPath]) {
    if (taken.includes(path)) throw bad(`The health endpoint ${path} is also the OpenAPI or MCP path.`, "Choose another health.path or health.readyPath.");
    const route = routes.find((r) => r.method === "GET" && r.path.replace(/\/+$/, "") === path.replace(/\/+$/, ""));
    if (route) throw bad(`The health endpoint ${path} is also the route GET ${route.path}.`, `Remove the GET ${route.path} route (createApp({ health }) answers it now), or choose another health.path or health.readyPath.`);
  }
  return resolved;
}

function checkTimeout(value: unknown, where: string): number | false {
  if (value === false || (typeof value === "number" && Number.isFinite(value) && value > 0)) return value;
  throw new InferloError("IL6017", `${where} must be a positive number of milliseconds or false, got ${typeof value === "string" ? JSON.stringify(value) : String(value)}.`, {
    fix: "Use a number such as 30000 (30 seconds), or false for no timeout.",
  });
}

function parseOrThrow(schema: AnySchema, value: unknown, where: string, coerce: boolean): unknown {
  const result = schema.safeParse(value, { coerce });
  if (!result.ok) throw new ValidationError(result.issues, where);
  return result.value;
}
