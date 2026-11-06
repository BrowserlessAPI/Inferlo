/**
 * Typed calls from one Inferlo service to another (microservices, part 1).
 *
 *   import { getTicket, createTicket } from "../../tickets/src/routes/tickets.ts"; // the other service's routes
 *   const tickets = serviceClient({ baseUrl: settings.TICKETS_URL, token: settings.TICKETS_TOKEN });
 *
 *   // in a route handler: input and answer are typed from the route
 *   const ticket = await tickets.call(getTicket, { params: { id }, ctx });
 *
 * The route definition gives the method, the path and the types; nothing is generated and nothing is global.
 * Passing ctx forwards the request id (X-Request-Id) and cancels the call when the request is aborted.
 */
import { InferloError } from "./errors.ts";
import type { RouteDef } from "./route.ts";

export interface ServiceClientOptions {
  /** Where the other service is reached, with any path prefix it is mounted under: "http://tickets.internal" or "https://api.example.com/v1". */
  baseUrl: string;
  /** Sent as Authorization: Bearer <token> on every call. */
  token?: string;
  /** Headers sent on every call. */
  headers?: Record<string, string>;
  /** Longest wait for one attempt, in milliseconds. Default 10000. */
  timeoutMs?: number;
  /**
   * Extra attempts for idempotent calls (GET, PUT, DELETE) that fail with a network error, a timeout, or a 502, 503
   * or 504 answer, waiting 100 ms, 200 ms, 400 ms... in between. POST and PATCH are never retried. Default 0.
   */
  retries?: number;
  /** The fetch to use. Default globalThis.fetch; pass otherApp.fetch to call an app in the same process (tests). */
  fetch?: (request: Request) => Promise<Response>;
}

/** A route made with route.<method>(...).handle(...): carries the types of its input and answer. */
export type TypedRoute = RouteDef & { readonly $response: unknown; readonly $input: { body: unknown; query: unknown; params: unknown } };

type ParamsInput<P> = keyof P extends never ? { params?: P } : { params: P };
type BodyInput<B> = undefined extends B ? { body?: B } : { body: B };

/** The request context to forward: pass the handler's ctx. */
export interface CallContext {
  requestId: string;
  signal: AbortSignal;
}

/** Options of one call, next to its params, query and body. */
export interface CallOptions {
  /** The handler's context: forwards its request id and cancels the call when the request is aborted. */
  ctx?: CallContext;
  /** Cancels the call (in addition to ctx). */
  signal?: AbortSignal;
  /** Headers for this call. */
  headers?: Record<string, string>;
}

export type CallInput<R extends TypedRoute> = ParamsInput<R["$input"]["params"]> & BodyInput<R["$input"]["body"]> & { query?: Partial<R["$input"]["query"]> } & CallOptions;

/** The answer of a route: its JSON data, undefined for 204, or the Response itself for routes that return one (streams, files). */
export type CallResult<R extends TypedRoute> = R["$response"] extends Response ? Response : R["$response"] extends void | undefined ? undefined : R["$response"];

export interface ServiceClient {
  /** Calls a route of the other service. Rejects with IL2008 when the call fails or answers with an error status. */
  call<R extends TypedRoute>(route: R, ...input: {} extends CallInput<R> ? [input?: CallInput<R>] : [input: CallInput<R>]): Promise<CallResult<R>>;
}

/** Raised when a call to another service fails: remoteStatus is its HTTP status (0 when no answer came), remoteCode its error code. */
export class ServiceCallError extends InferloError {
  readonly remoteStatus: number;
  readonly remoteCode: string | undefined;
  constructor(message: string, remoteStatus: number, remoteCode: string | undefined, fix: string, details: Record<string, unknown>) {
    super("IL2008", message, { status: 502, expose: false, fix, details });
    this.remoteStatus = remoteStatus;
    this.remoteCode = remoteCode;
  }
}

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const RETRY_STATUS = new Set([502, 503, 504]);

function invalid(message: string, fix: string): InferloError {
  return new InferloError("IL2009", message, { status: 500, expose: false, fix });
}

function isRouteDef(value: unknown): value is RouteDef {
  return typeof value === "object" && value !== null && (value as RouteDef).kind === "inferlo.route";
}

/** The path with :params filled in, each value URL-encoded. */
function fillPath(path: string, params: Record<string, unknown> | undefined, route: RouteDef): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === "") {
      throw invalid(`The call to ${route.method} ${route.path} has no value for the path parameter "${name}".`, `Pass it: client.call(route, { params: { ${name}: "..." } }).`);
    }
    return encodeURIComponent(String(value));
  });
}

const sleep = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** A client for calls to another Inferlo service. See ServiceClientOptions. */
export function serviceClient(options: ServiceClientOptions): ServiceClient {
  if (typeof options !== "object" || options === null) throw invalid("serviceClient() needs options.", 'Use serviceClient({ baseUrl: "http://tickets.internal" }).');
  for (const key of Object.keys(options)) {
    if (!["baseUrl", "token", "headers", "timeoutMs", "retries", "fetch"].includes(key)) {
      throw invalid(`serviceClient() has an unknown option "${key}".`, "The options are baseUrl, token, headers, timeoutMs, retries and fetch.");
    }
  }
  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw invalid(`serviceClient() baseUrl ${JSON.stringify(options.baseUrl)} is not a URL.`, 'Use the address of the other service, such as "http://tickets.internal" or "https://api.example.com/v1".');
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw invalid(`serviceClient() baseUrl must use http or https, got ${base.protocol}.`, 'Use "http://..." or "https://...".');
  if (base.search || base.hash) throw invalid("serviceClient() baseUrl must not have a query string or fragment.", "Pass query values per call: client.call(route, { query }).");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw invalid(`serviceClient() timeoutMs must be a positive number of milliseconds, got ${String(options.timeoutMs)}.`, "Use timeoutMs: 5000, or leave it out for 10 s.");
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw invalid(`serviceClient() retries must be a whole number from 0 to 10, got ${String(options.retries)}.`, "Use retries: 2 for idempotent calls that may meet a restarting instance.");
  const doFetch = options.fetch ?? ((request: Request) => globalThis.fetch(request));
  const basePath = base.pathname.replace(/\/+$/, "");

  return {
    async call(route: TypedRoute, input: CallInput<TypedRoute> = {} as CallInput<TypedRoute>) {
      if (!isRouteDef(route)) throw invalid("client.call() needs a route made with route.<method>(...).handle(...).", "Import the route from the other service and pass it: client.call(getTicket, { params: { id } }).");
      const { params, query, body, ctx, signal, headers } = input as { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown; ctx?: CallContext; signal?: AbortSignal; headers?: Record<string, string> };
      const url = new URL(base.origin + basePath + fillPath(route.path, params, route));
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v === undefined || v === null) continue;
        for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
      }
      const method = route.method.toUpperCase();
      const sent: Record<string, string> = { accept: "application/json", ...options.headers, ...headers };
      if (options.token) sent.authorization = `Bearer ${options.token}`;
      if (ctx?.requestId) sent["x-request-id"] = ctx.requestId;
      const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";
      if (hasBody) sent["content-type"] = "application/json";
      const payload = hasBody ? JSON.stringify(body) : undefined;
      const callerSignals = [ctx?.signal, signal].filter((s): s is AbortSignal => s !== undefined);
      const callerSignal = callerSignals.length ? AbortSignal.any(callerSignals) : undefined;
      const attempts = IDEMPOTENT.has(method) ? retries + 1 : 1;
      const where = `${method} ${url.origin}${url.pathname}`;
      const details = (extra: Record<string, unknown>) => ({ method, url: `${url.origin}${url.pathname}`, requestId: ctx?.requestId, ...extra });

      for (let attempt = 1; ; attempt++) {
        const timeout = AbortSignal.timeout(timeoutMs);
        const combined = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
        let response: Response;
        try {
          response = await doFetch(new Request(url, { method, headers: sent, body: payload, signal: combined }));
        } catch (error) {
          if (callerSignal?.aborted) throw callerSignal.reason ?? error;
          const timedOut = timeout.aborted;
          if (attempt < attempts) {
            await sleep(100 * 2 ** (attempt - 1), callerSignal);
            continue;
          }
          const failure = new ServiceCallError(
            timedOut ? `${where} did not answer within ${timeoutMs} ms.` : `${where} could not be reached: ${error instanceof Error ? error.message : String(error)}.`,
            0,
            undefined,
            timedOut ? "Check that the service is healthy, or raise serviceClient({ timeoutMs })." : "Check serviceClient({ baseUrl }) and that the service is running and reachable.",
            details({ attempts: attempt }),
          );
          (failure as { cause?: unknown }).cause = error;
          throw failure;
        }
        if (response.ok) {
          if (response.status === 204 || method === "HEAD") return undefined as never;
          const type = response.headers.get("content-type") ?? "";
          if (/^application\/(.+\+)?json\b/i.test(type)) return (await response.json()) as never;
          return response as never;
        }
        if (RETRY_STATUS.has(response.status) && attempt < attempts) {
          await response.body?.cancel();
          await sleep(100 * 2 ** (attempt - 1), callerSignal);
          continue;
        }
        let remote: { code?: string; message?: string } | undefined;
        try {
          remote = ((await response.json()) as { error?: { code?: string; message?: string } }).error;
        } catch {
          remote = undefined;
        }
        const code = typeof remote?.code === "string" ? remote.code : undefined;
        throw new ServiceCallError(
          `${where} answered ${response.status}${code ? ` ${code}` : ""}${remote?.message ? `: ${remote.message}` : ""}.`,
          response.status,
          code,
          response.status === 401 || response.status === 403
            ? "Check serviceClient({ token }) and the other service's auth."
            : response.status >= 500
              ? "See the other service's logs for this request id."
              : "Check the input against the other service's route, or handle the answer: catch the error and read error.remoteStatus.",
          details({ status: response.status, code, attempts: attempt }),
        );
      }
    },
  } as ServiceClient;
}
