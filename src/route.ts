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
import type { AI, StreamResult, Usage } from "./ai/index.ts";
import type { Db } from "./db/table.ts";
import type { Events } from "./events.ts";
import type { Jobs } from "./jobs.ts";
import type { AnyModel } from "./model.ts";
import type { Audit } from "./audit.ts";
import type { Cache, RouteCache } from "./cache.ts";
import type { Storage } from "./storage.ts";
import type { PermissionInput, Permissions } from "./permissions.ts";
import type { RateLimit } from "./rate-limit.ts";
import type { Sockets } from "./sockets.ts";
import type { AnySchema, Infer, InferInput, ObjectSchema } from "./schema.ts";

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
  /** Request body schema: JSON, a URL-encoded form, or multipart/form-data when it has t.file() fields. */
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
  /**
   * Cache this GET route's JSON responses in the app cache: { ttlMs: 60_000, by: "user", tags: ["tickets"] }.
   * "user" (default) keeps one response per signed-in user, "public" one for every caller. Remove them early with
   * ctx.cache.invalidate(tag). Responses carry an ETag, so clients revalidate with If-None-Match (304).
   */
  cache?: RouteCache;
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
  /** Publish events: await events.publish(orderPaid, { orderId }) queues the jobs subscribed with on(event, job). */
  events: Events;
  /** The app cache: await cache.getOrSet(key, { ttlMs: 60_000, tags: ["tickets"] }, compute), cache.invalidate("tickets"). */
  cache: Cache;
  /** Files (createApp({ storage })): await storage.put(`avatars/${user.id}.png`, body.avatar), storage.get(key), storage.delete(key). */
  storage: Storage;
  /** Send to WebSocket rooms: await sockets.broadcast(`project:${id}`, data), to the user's tenant's room with a tenant. */
  sockets: Sockets;
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

/**
 * What a caller sends to a route, before validation (defaults not yet applied): the body, query and path params.
 * Type only ($input on the route returned by handle()), used by serviceClient for typed calls.
 */
export interface RouteInput<Path extends string, B, Q, P> {
  body: B extends AnySchema ? InferInput<B> : undefined;
  query: Q extends AnySchema ? InferInput<Q> : Record<string, string | undefined>;
  params: P extends AnySchema ? InferInput<P> : PathParams<Path>;
}
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
  /** Set for WebSocket routes from route.ws(): the handler runs once per message instead of once per request. */
  readonly websocket?: true;
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
  ): RouteDef & { readonly $response: Awaited<R>; readonly $input: RouteInput<Path, B, Q, P> } {
    return { kind: "inferlo.route", method: this.method, path: this.path, options: this.options, handler: handler as Handler<AnyContext, unknown> } as unknown as RouteDef & {
      readonly $response: Awaited<R>;
      readonly $input: RouteInput<Path, B, Q, P>;
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

export interface SocketRouteOptions<M extends AnySchema | undefined, Q extends ObjectSchema<any> | undefined, P extends ObjectSchema<any> | undefined> {
  /** Who may connect. Default "user" (signed in), checked once when the socket opens. */
  auth?: Auth;
  /** A permission from createApp({ permissions }) the user must have to connect (checked with { user }). */
  permission?: AppPermission;
  /** Schema of each message (JSON text). A message that does not match gets an IL1001 error message back. */
  message?: M;
  /** Query string schema of the connection URL. */
  query?: Q;
  /** Path parameter schema. Without it, path params are strings. */
  params?: P;
  /**
   * Limit connections and messages per user, tenant or IP: { max: 30, per: "minute", by: "user" }. Opening the
   * socket and every message count. A refused connection answers 429; a message over the limit gets an IL2005 error message.
   */
  rateLimit?: RateLimit;
  /** One line shown in describe. */
  summary?: string;
  description?: string;
  tags?: string[];
}

/** The open connection, in a WebSocket handler. */
export interface Socket {
  /** A random id for this connection. */
  readonly id: string;
  /** Send a message to this client, as JSON. Does nothing once the socket is closed. */
  send(data: unknown): void;
  /** Close the connection: code 1000 (normal) by default. */
  close(code?: number, reason?: string): void;
  /**
   * Join a room, so sockets.broadcast(room, data) reaches this client. Rooms are per tenant: with a signed-in user
   * who has a tenant, the room is that tenant's. A closed socket leaves every room.
   */
  join(room: string): void;
  /** Leave a room joined with socket.join(room). */
  leave(room: string): void;
  /**
   * Stream a model's answer to this client: await socket.stream(ai.stream({ model: "fast", prompt })) sends
   * { type: "text", text } for each chunk as it arrives, then { type: "done", usage }, and resolves with the full
   * text and usage. Streams from ctx.ai stop when the socket closes (ctx.signal).
   */
  stream(result: StreamResult): Promise<{ text: string; usage: Usage }>;
}

export interface SocketContext<Message, Query, Params, User> {
  /** This message, validated against the route's message schema. */
  message: Message;
  query: Query;
  params: Params;
  /** The user who opened the socket (null only on public routes with no session). */
  user: User;
  socket: Socket;
  db: AppDb;
  ai: AI;
  jobs: Jobs;
  events: Events;
  cache: Cache;
  /** Files (createApp({ storage })), the same as ctx.storage in routes. */
  storage: Storage;
  /** Send to WebSocket rooms, this client's included when it joined: await sockets.broadcast(room, data). */
  sockets: Sockets;
  /** Write an audit log entry with the user and this connection's request id. */
  audit: Audit;
  /** Aborted when the socket closes. ctx.ai calls use it automatically. */
  signal: AbortSignal;
  /** The id of the request that opened the socket, also in its log entries. */
  requestId: string;
  /** URL and headers of the request that opened the socket. */
  url: URL;
  headers: Headers;
}

export class SocketRouteBuilder<Path extends string, M extends AnySchema | undefined, Q extends ObjectSchema<any> | undefined, P extends ObjectSchema<any> | undefined, A> {
  readonly path: Path;
  readonly options: SocketRouteOptions<M, Q, P>;

  constructor(path: Path, options: SocketRouteOptions<M, Q, P>) {
    this.path = path;
    this.options = options;
  }

  /**
   * The message handler, run for each message in the order they arrive. Return data to send it back as JSON, or
   * nothing; call ctx.socket.send(data) to send more. A thrown error is sent back as an error message (the socket stays open).
   */
  handle<R>(
    handler: Handler<
      SocketContext<
        M extends AnySchema ? Infer<M> : unknown,
        Q extends AnySchema ? Infer<Q> : Record<string, string | undefined>,
        P extends AnySchema ? Infer<P> : PathParams<Path>,
        UserFor<A>
      >,
      R
    >,
  ): RouteDef & { readonly $message: M extends AnySchema ? InferInput<M> : unknown; readonly $reply: Awaited<R> } {
    return {
      kind: "inferlo.route",
      method: "GET",
      path: this.path,
      options: this.options as RouteOptions<any, any, any>,
      handler: handler as unknown as Handler<AnyContext, unknown>,
      websocket: true,
    } as unknown as RouteDef & { readonly $message: M extends AnySchema ? InferInput<M> : unknown; readonly $reply: Awaited<R> };
  }
}

export const route = {
  get: builder("GET"),
  post: builder("POST"),
  put: builder("PUT"),
  patch: builder("PATCH"),
  delete: builder("DELETE"),
  /**
   * A WebSocket route: route.ws("/chat", { message: t.object({ text: t.string() }) }).handle(({ message, user, socket }) => ...).
   * Same auth, permissions and rate limits as HTTP routes; each JSON message is validated and handled in order.
   */
  ws: <
    const Path extends string,
    M extends AnySchema | undefined = undefined,
    Q extends ObjectSchema<any> | undefined = undefined,
    P extends ObjectSchema<any> | undefined = undefined,
    const A extends Auth = "user",
  >(
    path: Path,
    options: SocketRouteOptions<M, Q, P> & { auth?: A } = {},
  ) => new SocketRouteBuilder<Path, M, Q, P, A>(path, options),
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
