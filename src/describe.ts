/**
 * describe() returns a machine-readable map of the whole app. AI coding agents read it
 * (inferlo describe --json) instead of searching the codebase.
 */
import { describeDeprecation, resolveDeprecation } from "./deprecation.ts";
import type { App } from "./app.ts";
import type { ModuleInfo } from "./module.ts";
import { toolName } from "./mcp.ts";
import { columnName } from "./model.ts";
import type { AnySchema, JSONSchema } from "./schema.ts";

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
  models: { name: string; module?: string; fields: Record<string, FieldDescription> }[];
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
    params?: JSONSchema;
    query?: JSONSchema;
    body?: JSONSchema;
  }[];
  ai: { configured: boolean; aliases: Record<string, string[]> };
  jobs: { name: string; module?: string; summary?: string; retries: number; input: JSONSchema }[];
  /** Schedules from cron(schedule, job), in UTC. */
  crons: { schedule: string; job: string }[];
  /** Where queued jobs are kept. */
  jobQueue: "memory" | "database";
  /** Where ctx.cache and app.cache keep entries. */
  cache: "memory" | "database";
}

export const INFERLO_VERSION = "0.5.0";

function field(name: string, schema: AnySchema): FieldDescription {
  const d = schema.def;
  const out: FieldDescription = {
    type: d.kind,
    required: !d.optional && !d.hasDefault,
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
    models: app.models.map((m: { name: string; fields: Record<string, AnySchema> }) => ({
      name: m.name,
      ...(info.modelOwner.has(m.name) ? { module: info.modelOwner.get(m.name) } : {}),
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
      if (r.name) out.name = r.name;
      if (r.version) out.version = r.version;
      const owner = info.routeModule.get(r);
      if (owner) out.module = owner;
      if (o.permission) out.permission = o.permission;
      if (o.summary) out.summary = o.summary;
      if (o.tool) out.tool = toolName(r);
      if (o.rateLimit) out.rateLimit = { max: o.rateLimit.max, per: o.rateLimit.per, by: o.rateLimit.by ?? "user" };
      if (o.timeoutMs !== undefined) out.timeoutMs = o.timeoutMs;
      if (o.deprecated) out.deprecated = typeof o.deprecated === "object" ? describeDeprecation(resolveDeprecation(o.deprecated, `${r.method} ${r.path}`)!) : true;
      if (o.params) out.params = o.params.toJSONSchema();
      if (o.query) out.query = o.query.toJSONSchema();
      if (o.body) out.body = o.body.toJSONSchema();
      return out;
    }),
    ai: { configured: app.ai.configured, aliases: app.ai.aliases },
    jobQueue: app.jobs.queue,
    cache: app.cache.store,
    crons: app.jobs.crons.map((c) => ({ schedule: c.schedule, job: c.job.name })),
    jobs: app.jobs.list.map((j) => ({ name: j.name, ...(info.jobModule.has(j.name) ? { module: info.jobModule.get(j.name) } : {}), ...(j.options.summary ? { summary: j.options.summary } : {}), retries: j.options.retries ?? 3, input: j.options.input.toJSONSchema() })),
  };
}
