/**
 * describe() returns a machine-readable map of the whole app. AI coding agents read it
 * (inferlo describe --json) instead of searching the codebase.
 */
import { describeDeprecation, resolveDeprecation } from "./deprecation.ts";
import type { App } from "./app.ts";
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
  models: { name: string; fields: Record<string, FieldDescription> }[];
  routes: {
    name?: string;
    method: string;
    path: string;
    auth: string;
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
  jobs: { name: string; summary?: string; retries: number; input: JSONSchema }[];
  /** Schedules from cron(schedule, job), in UTC. */
  crons: { schedule: string; job: string }[];
  /** Where queued jobs are kept. */
  jobQueue: "memory" | "database";
}

export const INFERLO_VERSION = "0.4.0";

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

export function describeApp(app: App<any>, options: { auth: boolean; openapi: string | false; mcp: string | false; health: string | false; ready: string | false; metrics: string | false; secureHeaders: string[]; requestTimeoutMs: number | false; logging: AppDescription["logging"]; description?: string }): AppDescription {
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
    models: app.models.map((m: { name: string; fields: Record<string, AnySchema> }) => ({
      name: m.name,
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
    crons: app.jobs.crons.map((c) => ({ schedule: c.schedule, job: c.job.name })),
    jobs: app.jobs.list.map((j) => ({ name: j.name, ...(j.options.summary ? { summary: j.options.summary } : {}), retries: j.options.retries ?? 3, input: j.options.input.toJSONSchema() })),
  };
}
