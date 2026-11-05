/** OpenAPI 3.1 document generated from routes. Served at /openapi.json by default. */
import { describeDeprecation, resolveDeprecation } from "./deprecation.ts";
import type { App } from "./app.ts";
import type { ModuleInfo } from "./module.ts";
import { toolName } from "./mcp.ts";
import type { JSONSchema } from "./schema.ts";

const errorSchema: JSONSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string", examples: ["IL1001"] },
        message: { type: "string" },
        fix: { type: "string" },
        details: {},
        docs: { type: "string", format: "uri" },
      },
      required: ["code", "message", "docs"],
    },
  },
  required: ["error"],
};

export function buildOpenAPI(app: App<any>, options: { description?: string; auth: boolean; modules?: ModuleInfo; version?: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  // A version's document has its routes and the routes outside every version.
  const routes = options.version === undefined ? app.routes : app.routes.filter((r) => r.version === undefined || r.version === options.version);
  for (const route of routes) {
    const o = route.options;
    const openPath = route.path.replace(/:([^/]+)/g, "{$1}").replace(/\/\*$/, "/{wildcard}");
    const parameters: Record<string, unknown>[] = [];
    const paramProps = (o.params?.toJSONSchema().properties as Record<string, JSONSchema>) ?? {};
    for (const key of route.path.split("/").filter((p) => p.startsWith(":")).map((p) => p.slice(1))) {
      parameters.push({ name: key, in: "path", required: true, schema: paramProps[key] ?? { type: "string" } });
    }
    if (o.query) {
      const q = o.query.toJSONSchema();
      const required = new Set((q.required as string[]) ?? []);
      for (const [name, schema] of Object.entries((q.properties as Record<string, JSONSchema>) ?? {})) {
        parameters.push({ name, in: "query", required: required.has(name), schema });
      }
    }
    const isPublic = (o.auth ?? "user") === "public";
    const operation: Record<string, unknown> = {
      operationId: route.name ?? toolName(route),
      summary: o.summary,
      description: o.description,
      // Routes of a feature module are tagged with its name unless they set their own tags.
      tags: o.tags ?? (options.modules?.routeModule.has(route) ? [options.modules.routeModule.get(route)!] : undefined),
      parameters: parameters.length ? parameters : undefined,
      requestBody: o.body ? { required: !o.body.def.optional, content: { "application/json": { schema: o.body.toJSONSchema() } } } : undefined,
      responses: {
        "200": { description: "Success", content: o.response ? { "application/json": { schema: o.response.toJSONSchema() } } : undefined },
        ...(o.body || o.query || o.params ? { "422": { description: "Validation failed (IL1001)", content: { "application/json": { schema: errorSchema } } } } : {}),
        ...(!isPublic ? { "401": { description: "Sign in required (IL3001)", content: { "application/json": { schema: errorSchema } } } } : {}),
        ...(o.permission ? { "403": { description: `Needs the "${o.permission}" permission (IL3004)`, content: { "application/json": { schema: errorSchema } } } } : {}),
        ...(o.rateLimit
          ? { "429": { description: `Too many requests (IL2005): ${o.rateLimit.max} per ${o.rateLimit.per} per ${o.rateLimit.by ?? "user"}`, content: { "application/json": { schema: errorSchema } } } }
          : {}),
      },
      security: !isPublic && options.auth ? [{ bearerAuth: [] }] : undefined,
      "x-inferlo-auth": o.auth ?? "user",
      "x-inferlo-permission": o.permission,
      "x-inferlo-cache": o.cache ? { ttlMs: o.cache.ttlMs, by: o.cache.by ?? "user", tags: [...(o.cache.tags ?? [])] } : undefined,
      "x-inferlo-tool": o.tool ? toolName(route) : undefined,
      deprecated: o.deprecated ? true : undefined,
      "x-inferlo-deprecation": typeof o.deprecated === "object" ? describeDeprecation(resolveDeprecation(o.deprecated, `${route.method} ${route.path}`)!) : undefined,
    };
    for (const key of Object.keys(operation)) if (operation[key] === undefined) delete operation[key];
    (paths[openPath] ??= {})[route.method.toLowerCase()] = operation;
  }
  const schemas: Record<string, JSONSchema> = {};
  for (const m of app.models) schemas[m.name] = m.row.toJSONSchema();
  return {
    openapi: "3.1.0",
    info: { title: app.name, version: app.version, description: options.description, ...(options.version ? { "x-inferlo-api-version": options.version } : {}) },
    ...(options.modules?.modules.length
      ? { tags: options.modules.modules.map((m) => (m.description ? { name: m.name, description: m.description } : { name: m.name })) }
      : {}),
    paths,
    components: {
      schemas: { ...schemas, Error: errorSchema },
      ...(options.auth ? { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } } : {}),
    },
  };
}
