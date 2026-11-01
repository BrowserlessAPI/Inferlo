/**
 * Built-in MCP server (Model Context Protocol, Streamable HTTP transport, JSON responses).
 * Routes with `tool: true` become tools. Tool calls run through the normal router, so auth,
 * roles and validation apply exactly as they do for HTTP clients: the caller's Authorization
 * header is forwarded.
 */
import type { App } from "./app.ts";
import { InferloError } from "./errors.ts";
import type { RouteDef } from "./route.ts";
import type { JSONSchema } from "./schema.ts";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  route: RouteDef;
}

function pathKeys(path: string): string[] {
  return path.split("/").filter((p) => p.startsWith(":")).map((p) => p.slice(1));
}

export function toolName(route: RouteDef): string {
  const opt = typeof route.options.tool === "object" ? route.options.tool.name : undefined;
  if (opt) return opt;
  if (route.name) return route.name;
  const slug = route.path.replace(/[:/]+/g, "_").replace(/^_|_$/g, "") || "root";
  return `${route.method.toLowerCase()}_${slug}`;
}

export function toolDefinitions(app: App<any>): ToolDefinition[] {
  return app.routes
    .filter((r) => r.options.tool)
    .map((route) => {
      const properties: Record<string, JSONSchema> = {};
      const required = new Set<string>();
      const add = (schema: JSONSchema | undefined) => {
        if (!schema) return;
        for (const [k, v] of Object.entries((schema.properties as Record<string, JSONSchema>) ?? {})) properties[k] = v;
        for (const k of (schema.required as string[]) ?? []) required.add(k);
      };
      const o = route.options;
      if (o.params) add(o.params.toJSONSchema());
      else for (const key of pathKeys(route.path)) (properties[key] = { type: "string" }), required.add(key);
      if (o.query) add(o.query.toJSONSchema());
      if (o.body) {
        const body = o.body.toJSONSchema();
        if (body.type === "object") add(body);
        else {
          properties.body = body;
          required.add("body");
        }
      }
      const toolOpt = typeof o.tool === "object" ? o.tool : {};
      return {
        name: toolName(route),
        description: toolOpt.description ?? o.description ?? o.summary ?? `${route.method} ${route.path}`,
        inputSchema: { type: "object", properties, ...(required.size ? { required: [...required] } : {}) },
        route,
      };
    });
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcp(app: App<any>, req: Request, headers: Headers, testUsers: WeakMap<Request, unknown>): Promise<Response> {
  headers.set("content-type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    headers.set("allow", "POST");
    return new Response(JSON.stringify(rpcError(null, -32000, "Use POST for MCP requests.")), { status: 405, headers });
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify(rpcError(null, -32700, "Parse error")), { status: 400, headers });
  }
  const tools = toolDefinitions(app);
  const handleOne = async (msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }) => {
    const isNotification = msg?.id === undefined || String(msg?.method).startsWith("notifications/");
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
    if (String(msg.method).startsWith("notifications/")) return undefined;
    switch (msg.method) {
      case "initialize": {
        const requested = String(msg.params?.protocolVersion ?? "");
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: app.name, version: app.version },
            instructions: `Tools for ${app.name}. Each tool is an HTTP route of this app and follows its permissions.`,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id: msg.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: msg.id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const tool = tools.find((t) => t.name === name);
        if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const response = await callTool(app, tool, args, req, testUsers);
        const text = await response.text();
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: text || `${response.status}` }], isError: !response.ok },
        };
      }
      default:
        if (isNotification) return undefined;
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };

  if (Array.isArray(payload)) {
    const results = (await Promise.all(payload.map(handleOne))).filter(Boolean);
    return results.length ? new Response(JSON.stringify(results), { status: 200, headers }) : new Response(null, { status: 202, headers });
  }
  const result = await handleOne(payload as never);
  return result ? new Response(JSON.stringify(result), { status: 200, headers }) : new Response(null, { status: 202, headers });
}

async function callTool(app: App<any>, tool: ToolDefinition, args: Record<string, unknown>, original: Request, testUsers: WeakMap<Request, unknown>): Promise<Response> {
  const route = tool.route;
  const o = route.options;
  const keys = pathKeys(route.path);
  const queryKeys = new Set(Object.keys((o.query?.toJSONSchema().properties as object) ?? {}));
  let path = route.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (keys.includes(k)) path = path.replace(`:${k}`, encodeURIComponent(String(v)));
    else if (queryKeys.has(k)) {
      if (Array.isArray(v)) for (const item of v) query.append(k, String(item));
      else if (v !== undefined && v !== null) query.set(k, String(v));
    } else body[k] = v;
  }
  if (keys.some((k) => path.includes(`:${k}`))) {
    return new Response(JSON.stringify(new InferloError("IL1001", `Missing path parameter for ${route.path}.`, { status: 422 }).toJSON()), { status: 422 });
  }
  const url = new URL(path, original.url);
  url.search = query.toString();
  const headers = new Headers();
  for (const h of ["authorization", "cookie", "x-api-key"]) {
    const v = original.headers.get(h);
    if (v) headers.set(h, v);
  }
  let payload: string | undefined;
  if (o.body) {
    headers.set("content-type", "application/json");
    const bodySchema = o.body.toJSONSchema();
    payload = JSON.stringify(bodySchema.type === "object" ? body : body.body);
  }
  const inner = new Request(url, { method: route.method, headers, body: payload });
  if (testUsers.has(original)) testUsers.set(inner, testUsers.get(original));
  return app.fetch(inner);
}
