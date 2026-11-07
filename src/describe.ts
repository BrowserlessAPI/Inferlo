/**
 * describe() returns a machine-readable map of the whole app. AI coding agents read it
 * (inferlo describe --json) instead of searching the codebase.
 */
import { describeDeprecation, resolveDeprecation } from "./deprecation.ts";
import type { App } from "./app.ts";
import type { ModuleInfo } from "./module.ts";
import { toolName } from "./mcp.ts";
import { columnName } from "./model.ts";
import { containsFile, type AnySchema, type JSONSchema } from "./schema.ts";

export interface FieldDescription {
  type: string;
  required: boolean;
  nullable: boolean;
  default?: unknown;
  unique?: boolean;
  index?: boolean;
  references?: string;
  values?: readonly unknown[];
  column: string;
  description?: string;
}

export interface AppDescription {
  inferlo: string;
  name: string;
  version: string;
  description?: string;
  database: string;
  auth: boolean;
  endpoints: { openapi: string | false; mcp: string | false; health: string | false; ready: string | false; metrics: string | false };
  /** Security headers sent on responses (lowercase names; strict-transport-security only over HTTPS). */
  secureHeaders: string[];
  /** Default time limit for routes in milliseconds (createApp({ requestTimeoutMs })), or false. */
  requestTimeoutMs: number | false;
  /** The built-in logger's format and whether each request is logged (createApp({ logging })). "custom" when the app has its own logger. */
  logging: { format: "text" | "json" | "custom"; requests: boolean };
  /** Feature modules (createApp({ modules })): what each contains, depends on and offers other modules. */
  modules: { name: string; description?: string; imports: string[]; models: string[]; routes: string[]; jobs: string[]; provides: string[] }[];
  /** module: the feature module that owns the model, when it is in one. */
  /** tenant: true for tenant-scoped models (model(name, fields, { tenant: true })), whose rows ctx.db filters by the current tenant. */
  models: { name: string; module?: string; tenant?: true; fields: Record<string, FieldDescription> }[];
  /** API versions from apiVersion("v1", routes), oldest first, with the path of each version's OpenAPI document. */
  versions: { name: string; openapi: string | false }[];
  /** Named permissions from createApp({ permissions }), with the roles of roles rules. */
  permissions: { name: string; roles?: string[] }[];
  routes: {
    /** The API version of the route ("v1"), when it comes from apiVersion(). */
    version?: string;
    /** The feature module the route belongs to, when it is in one. */
    module?: string;
    name?: string;
    method: string;
    path: string;
    /** true for WebSocket routes (route.ws): method is "GET" (the upgrade request) and message is the schema of each message. */
    websocket?: true;
    message?: JSONSchema;
    auth: string;
    /** The permission the user must have (route option permission). */
    permission?: string;
    summary?: string;
    tool?: string;
    rateLimit?: { max: number; per: string; by: string };
    /** The route's own timeoutMs, when it sets one (otherwise requestTimeoutMs applies). */
    timeoutMs?: number | false;
    /** true, or when the route was deprecated, when it stops working and where the migration is explained. */
    deprecated?: true | { since?: string; sunset?: string; link?: string };
    /** The route's response cache (route option cache). */
    cache?: { ttlMs: number; by: "user" | "tenant" | "public"; tags: string[] };
    params?: JSONSchema;
    query?: JSONSchema;
    body?: JSONSchema;
    /** "multipart/form-data" when the body has t.file() fields; otherwise the body is JSON (or a URL-encoded form). */
    bodyType?: "multipart/form-data";
  }[];
  ai: { configured: boolean; aliases: Record<string, string[]> };
  jobs: { name: string; module?: string; summary?: string; retries: number; input: JSONSchema }[];
  /** Schedules from cron(schedule, job), in UTC. */
  crons: { schedule: string; job: string }[];
  /** Events with subscriptions in this app, from on(event, job): the payload schema and the jobs each one queues. */
  events: { name: string; summary?: string; payload: JSONSchema; jobs: string[] }[];
  /** How events reach other services (createApp({ events: { transport } })), when the app has a transport: "redis". */
  eventTransport?: string;
  /** Where queued jobs are kept. */
  jobQueue: "memory" | "database" | "redis";
  /** Where ctx.cache and app.cache keep entries. */
  cache: "memory" | "database" | "redis";
  /** Where ctx.storage and app.storage keep files ("memory", "disk" or a custom store's name), or null without createApp({ storage }). */
  storage: string | null;
}

export const INFERLO_VERSION = "0.7.0";

function field(name: string, schema: AnySchema): FieldDescription {
  const d = schema.def;
  const out: FieldDescription = {
    type: d.kind,
    required: !d.optional && !d.hasDefault && !d.system,
    nullable: d.nullable,
    column: columnName(name),
  };
  if (d.hasDefault) out.default = typeof d.defaultValue === "function" ? "(function)" : d.defaultValue;
  if (d.unique) out.unique = true;
  if (d.index) out.index = true;
  if (d.refTable) out.references = d.refTable;
  if (d.values && d.kind === "enum") out.values = d.values;
  if (d.description) out.description = d.description;
  return out;
}

export function describeApp(app: App<any>, options: { auth: boolean; openapi: string | false; mcp: string | false; health: string | false; ready: string | false; metrics: string | false; secureHeaders: string[]; requestTimeoutMs: number | false; logging: AppDescription["logging"]; description?: string; modules: ModuleInfo; versions: AppDescription["versions"]; permissions: AppDescription["permissions"] }): AppDescription {
  const info = options.modules;
  return {
    inferlo: INFERLO_VERSION,
    name: app.name,
    version: app.version,
    description: options.description,
    database: app.db.$adapter.dialect,
    auth: options.auth,
    endpoints: { openapi: options.openapi, mcp: options.mcp, health: options.health, ready: options.ready, metrics: options.metrics },
    secureHeaders: options.secureHeaders,
    requestTimeoutMs: options.requestTimeoutMs,
    logging: options.logging,
    versions: options.versions,
    permissions: options.permissions,
    modules: info.modules.map((m) => ({
      name: m.name,
      ...(m.description ? { description: m.description } : {}),
      imports: m.imports.map((d) => d.name),
      models: m.models.map((model) => model.name),
      routes: app.routes.filter((r) => info.routeModule.get(r) === m.name).map((r) => `${r.method} ${r.path}`),
      jobs: app.jobs.list.filter((j) => info.jobModule.get(j.name) === m.name).map((j) => j.name),
      provides: Object.keys(m.provides),
    })),
    models: app.models.map((m: { name: string; tenant?: boolean; fields: Record<string, AnySchema> }) => ({
      name: m.name,
      ...(info.modelOwner.has(m.name) ? { module: info.modelOwner.get(m.name) } : {}),
      ...(m.tenant ? { tenant: true as const } : {}),
      fields: Object.fromEntries([
        ["id", { type: "uuid", required: false, nullable: false, column: "id", description: "Set automatically" }],
        ...Object.entries(m.fields).map(([k, s]) => [k, field(k, s)]),
        ["createdAt", { type: "date", required: false, nullable: false, column: "created_at", description: "Set automatically" }],
        ["updatedAt", { type: "date", required: false, nullable: false, column: "updated_at", description: "Set automatically" }],
      ]),
    })),
    routes: app.routes.map((r) => {
      const o = r.options;
      const out: AppDescription["routes"][number] = { method: r.method, path: r.path, auth: o.auth ?? "user" };
      if (r.websocket) {
        out.websocket = true;
        const message = (o as { message?: { toJSONSchema(): JSONSchema } }).message;
        if (message) out.message = message.toJSONSchema();
      }
      if (r.name) out.name = r.name;
      if (r.version) out.version = r.version;
      const owner = info.routeModule.get(r);
      if (owner) out.module = owner;
      if (o.permission) out.permission = o.permission;
      if (o.summary) out.summary = o.summary;
      if (o.tool) out.tool = toolName(r);
      if (o.rateLimit) out.rateLimit = { max: o.rateLimit.max, per: o.rateLimit.per, by: o.rateLimit.by ?? "user" };
      if (o.timeoutMs !== undefined) out.timeoutMs = o.timeoutMs;
      if (o.cache) out.cache = { ttlMs: o.cache.ttlMs, by: o.cache.by ?? "user", tags: [...(o.cache.tags ?? [])] };
      if (o.deprecated) out.deprecated = typeof o.deprecated === "object" ? describeDeprecation(resolveDeprecation(o.deprecated, `${r.method} ${r.path}`)!) : true;
      if (o.params) out.params = o.params.toJSONSchema();
      if (o.query) out.query = o.query.toJSONSchema();
      if (o.body) out.body = o.body.toJSONSchema();
      if (o.body && containsFile(o.body)) out.bodyType = "multipart/form-data";
      return out;
    }),
    ai: { configured: app.ai.configured, aliases: app.ai.aliases },
    jobQueue: app.jobs.queue,
    cache: app.cache.store,
    storage: app.storage.store,
    crons: app.jobs.crons.map((c) => ({ schedule: c.schedule, job: c.job.name })),
    events: app.events.list.map((e) => ({
      name: e.name,
      ...(e.summary ? { summary: e.summary } : {}),
      payload: e.payload.toJSONSchema(),
      jobs: app.events.subscriptions.filter((s) => s.event === e).map((s) => s.job.name),
    })),
    ...(app.events.transport ? { eventTransport: app.events.transport } : {}),
    jobs: app.jobs.list.map((j) => ({ name: j.name, ...(info.jobModule.has(j.name) ? { module: info.jobModule.get(j.name) } : {}), ...(j.options.summary ? { summary: j.options.summary } : {}), retries: j.options.retries ?? 3, input: j.options.input.toJSONSchema() })),
  };
}
