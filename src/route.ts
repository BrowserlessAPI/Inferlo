/**
 * Routes are plain values. Define them anywhere, export them, and pass the modules to createApp.
 *
 *   export const createTicket = route.post("/tickets", {
 *     auth: "user",
 *     body: Ticket.pick("title", "body"),
 *   }).handle(({ body, user, db }) => db.tickets.insert({ ...body, ownerId: user.id }))
 *
 * Secure by default: routes require a signed-in user unless you set auth: "public".
 */
import type { Deprecation } from "./deprecation.ts";
import type { AI } from "./ai/index.ts";
import type { Db } from "./db/table.ts";
import type { Jobs } from "./jobs.ts";
import type { AnyModel } from "./model.ts";
import type { Audit } from "./audit.ts";
import type { PermissionInput, Permissions } from "./permissions.ts";
import type { RateLimit } from "./rate-limit.ts";
import type { AnySchema, Infer, ObjectSchema } from "./schema.ts";

/**
 * Register your app's models and user type once, so every handler is fully typed:
 *
 *   declare module "@browserlessapi/inferlo" {
 *     interface Register { models: typeof models; user: User; permissions: typeof access }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Register {}

type Registered<K extends string, Fallback> = Register extends { [P in K]: infer V } ? V : Fallback;
export type AppModels = Registered<"models", readonly AnyModel[]> extends infer M extends readonly AnyModel[] ? M : readonly AnyModel[];
export type AppUser = Registered<"user", { id: string; roles?: string[] }>;
export type AppDb = Db<AppModels>;
/**
 * The permission names a route's `permission` option accepts. With `permissions: typeof access` in Register, only the
 * names whose rule needs nothing but { user } (roles rules and rules of the user alone), so a typo is a type error.
 */
export type AppPermission = Registered<"permissions", undefined> extends Permissions<infer R>
  ? { [K in keyof R & string]: { user: AppUser } extends PermissionInput<R[K]> ? K : never }[keyof R & string]
  : string;

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** "public": anyone. "user": any signed-in user. Any other string: the user must have that role. */
export type Auth = "public" | "user" | (string & {});

export interface ToolOptions {
  /** Tool name for MCP clients. Defaults to the exported route name (e.g. createTicket). */
  name?: string;
  /** What the tool does, written for an AI model. Defaults to the route description. */
  description?: string;
}

export interface RouteOptions<B extends AnySchema | undefined, Q extends ObjectSchema<any> | undefined, P extends ObjectSchema<any> | undefined> {
  /** Who may call this route. Default "user" (signed in). */
  auth?: Auth;
  /**
   * A permission from createApp({ permissions }) the signed-in user must have, checked with { user } before the
   * handler runs (also when the route is called as an AI tool). Denied: 403 IL3004. For rules that also need a
   * resource, call access.authorize(name, { user, ticket }) in the handler instead. Typed from Register's permissions.
   */
  permission?: AppPermission;
  /** Request body schema (JSON or form). */
  body?: B;
  /** Query string schema. Strings are converted to numbers and booleans automatically. */
  query?: Q;
  /** Path parameter schema. Without it, path params are strings. */
  params?: P;
  /** Response schema, used for OpenAPI and MCP docs. */
  response?: AnySchema;
  /** One line shown in OpenAPI, describe and MCP. */
  summary?: string;
  description?: string;
  tags?: string[];
  /** Expose this route as an MCP tool for AI agents. Same auth rules apply. */
  tool?: boolean | ToolOptions;
  /** Limit requests per user or IP: { max: 10, per: "minute", by: "user" }. More raise IL2005 (HTTP 429). */
  rateLimit?: RateLimit;
  /**
   * Longest time in milliseconds this route may take (reading the body and running the handler) before it
   * answers 503 IL2007 and ctx.signal is aborted. Overrides createApp({ requestTimeoutMs }); false turns it off.
   */
  timeoutMs?: number | false;
  /**
   * Mark the route deprecated: true, or { since, sunset, link } to also send the Deprecation, Sunset and
   * Link rel="deprecation" headers on every response. Shown in OpenAPI, describe and MCP tool descriptions.
   */
  deprecated?: boolean | Deprecation;
}

type PathParams<P extends string> = P extends `${string}:${infer Param}/${infer Rest}`
  ? { [K in Param | keyof PathParams<`/${Rest}`>]: string }
  : P extends `${string}:${infer Param}`
    ? { [K in Param]: string }
    : {};

type UserFor<A> = A extends "public" ? AppUser | null : AppUser;

export interface Context<Body, Query, Params, User> {
  body: Body;
  query: Query;
  params: Params;
  /** The signed-in user (null only on public routes with no session). */
  user: User;
  db: AppDb;
  ai: AI;
  /** Queue background jobs: await jobs.enqueue(sendEmail, { to }). */
  jobs: Jobs;
  req: Request;
  url: URL;
  headers: Headers;
  /** Set the response status code. */
  status(code: number): void;
  /** Set a response header. */
  header(name: string, value: string): void;
  /** Values shared by middleware for this request. */
  state: Record<string, unknown>;
  /**
   * Aborted when the request times out (requestTimeoutMs or the route's timeoutMs) or the client disconnects.
   * ctx.ai calls use it automatically; pass it to fetch and other slow work: fetch(url, { signal }).
   */
  signal: AbortSignal;
  /** This request's id: sent back in the X-Request-Id header and added to the request's log entries. */
  requestId: string;
  /** Run work after the response is sent (logging, webhooks). Errors are logged, not thrown. */
  waitUntil(promise: Promise<unknown>): void;
  /**
   * Write an audit log entry with the signed-in user and this request's id (needs AuditLog in createApp({ models })):
   * await audit("tickets.update", { model: "tickets", before: ticket, after: updated }).
   */
  audit: Audit;
}

export type AnyContext = Context<any, any, any, any>;
export type Handler<C, R> = (ctx: C) => R | Promise<R>;

export interface RouteDef {
  readonly kind: "inferlo.route";
  readonly method: Method;
  readonly path: string;
  readonly options: RouteOptions<any, any, any>;
  readonly handler: Handler<AnyContext, unknown>;
  /** Export name, filled in by createApp when routes are passed as modules. */
  name?: string;
  /** API version ("v1") when the route comes from apiVersion("v1", routes). */
  readonly version?: string;
}

export class RouteBuilder<Path extends string, B extends AnySchema | undefined, Q extends ObjectSchema<any> | undefined, P extends ObjectSchema<any> | undefined, A> {
  readonly method: Method;
  readonly path: Path;
  readonly options: RouteOptions<B, Q, P>;

  constructor(method: Method, path: Path, options: RouteOptions<B, Q, P>) {
    this.method = method;
    this.path = path;
    this.options = options;
  }

  /** The request handler. Return data (sent as JSON), a Response, or nothing (204). */
  handle<R>(
    handler: Handler<
      Context<
        B extends AnySchema ? Infer<B> : undefined,
        Q extends AnySchema ? Infer<Q> : Record<string, string | undefined>,
        P extends AnySchema ? Infer<P> : PathParams<Path>,
        UserFor<A>
      >,
      R
    >,
  ): RouteDef & { readonly $response: Awaited<R> } {
    return { kind: "inferlo.route", method: this.method, path: this.path, options: this.options, handler: handler as Handler<AnyContext, unknown> } as unknown as RouteDef & {
      readonly $response: Awaited<R>;
    };
  }
}

function builder(method: Method) {
  return <
    const Path extends string,
    B extends AnySchema | undefined = undefined,
    Q extends ObjectSchema<any> | undefined = undefined,
    P extends ObjectSchema<any> | undefined = undefined,
    const A extends Auth = "user",
  >(
    path: Path,
    options: RouteOptions<B, Q, P> & { auth?: A } = {},
  ) => new RouteBuilder<Path, B, Q, P, A>(method, path, options);
}

export const route = {
  get: builder("GET"),
  post: builder("POST"),
  put: builder("PUT"),
  patch: builder("PATCH"),
  delete: builder("DELETE"),
};

export function isRoute(value: unknown): value is RouteDef {
  return typeof value === "object" && value !== null && (value as RouteDef).kind === "inferlo.route";
}

/** The routes in route sources: routes, arrays and modules (import * as tickets), named after their exports. */
export function collectRoutes(sources: unknown): RouteDef[] {
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
