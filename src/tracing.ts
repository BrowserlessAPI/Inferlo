/**
 * OpenTelemetry tracing, with no dependency: pass the OpenTelemetry API you already use.
 *
 *   import * as otel from "@opentelemetry/api";
 *   createApp({ tracing: { api: otel } })
 *
 * Every request gets a server span ("GET /tickets/:id") that continues the caller's trace (W3C traceparent, through
 * the propagator your OpenTelemetry SDK registers), runs the handler inside it so spans you or instrumentations
 * start nest under it, and puts traceId and spanId on the request's log entries. AI calls get client spans with the
 * model, tokens and cost (also with createAI({ tracing }) on its own), and database queries made while a request
 * or job is traced get client spans with the table and operation. Without an SDK, the API's no-op tracer is used
 * and nothing is recorded.
 */
import type { Adapter } from "./db/types.ts";
import { InferloError } from "./errors.ts";

/** The parts of a span Inferlo uses (an @opentelemetry/api Span). */
export interface OtelSpan {
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: unknown): void;
  updateName(name: string): unknown;
  end(): void;
  isRecording(): boolean;
}

/** The parts of @opentelemetry/api Inferlo uses: import * as otel from "@opentelemetry/api", then { api: otel }. */
export interface OtelApi {
  trace: {
    getTracer(name: string, version?: string): { startSpan(name: string, options?: { kind?: number; attributes?: Record<string, string | number | boolean> }, context?: unknown): OtelSpan };
    setSpan(context: unknown, span: OtelSpan): unknown;
    /** The span of a context. Database spans are only started inside one (a request or a job). */
    getSpan?(context: unknown): OtelSpan | undefined;
  };
  context: { active(): unknown; with<T>(context: unknown, fn: () => T): T };
  propagation: { extract(context: unknown, carrier: unknown, getter?: unknown): unknown };
  SpanKind: { SERVER: number; CLIENT?: number };
  SpanStatusCode: { ERROR: number };
}

export interface TracingConfig {
  /** The OpenTelemetry API: import * as otel from "@opentelemetry/api", then createApp({ tracing: { api: otel } }). */
  api: OtelApi;
  /** The tracer name. Default: the app's name (createApp), or "inferlo" (createAI on its own). */
  tracerName?: string;
}

type Attributes = Record<string, string | number | boolean>;

/** CLIENT in @opentelemetry/api's SpanKind (the same in every 1.x release). */
const CLIENT_KIND = 2;

/** Reads incoming trace headers (traceparent, tracestate, baggage) for the propagator. */
const headerGetter = {
  get(carrier: Headers, key: string): string | undefined {
    return carrier.get(key) ?? undefined;
  },
  keys(carrier: Headers): string[] {
    return [...carrier.keys()];
  },
};

const INVALID_TRACE = "00000000000000000000000000000000";

export interface RequestTracing {
  /** Starts the server span of a request and runs fn inside it. */
  run<T>(req: Request, url: URL, fn: (span: OtelSpan) => Promise<T>): Promise<T>;
}

/** Checks a tracing option (createApp or createAI) and returns it, or undefined without tracing. */
export function checkTracing(option: unknown, where: "createApp" | "createAI"): TracingConfig | undefined {
  if (option === undefined || option === false) return undefined;
  const config = option as TracingConfig;
  const api = config?.api as OtelApi | undefined;
  const valid =
    config !== null &&
    typeof config === "object" &&
    typeof api?.trace?.getTracer === "function" &&
    typeof api.trace.setSpan === "function" &&
    typeof api.context?.with === "function" &&
    typeof api.context.active === "function" &&
    typeof api.propagation?.extract === "function" &&
    typeof api.SpanKind?.SERVER === "number" &&
    typeof api.SpanStatusCode?.ERROR === "number" &&
    (config.tracerName === undefined || (typeof config.tracerName === "string" && config.tracerName.length > 0));
  if (!valid) {
    throw new InferloError("IL6030", "Invalid tracing options: tracing needs { api } with the OpenTelemetry API.", {
      fix: `Install @opentelemetry/api (and an OpenTelemetry SDK that exports the spans), then: import * as otel from "@opentelemetry/api"; ${where}({ tracing: { api: otel } }).`,
    });
  }
  return config;
}

/** Checks createApp({ tracing }) and returns the request tracer, or undefined without tracing. */
export function requestTracing(option: unknown, appName: string, appVersion: string): RequestTracing | undefined {
  const config = checkTracing(option, "createApp");
  if (!config) return undefined;
  const api = config.api;
  const tracer = api.trace.getTracer(config.tracerName ?? appName, appVersion);
  return {
    run(req, url, fn) {
      const method = req.method.toUpperCase();
      const parent = api.propagation.extract(api.context.active(), req.headers, headerGetter);
      const attributes: Attributes = {
        "http.request.method": method,
        "url.path": url.pathname,
        "url.scheme": url.protocol.replace(/:$/, ""),
        "server.address": url.hostname,
      };
      if (url.port) attributes["server.port"] = Number(url.port);
      const agent = req.headers.get("user-agent");
      if (agent) attributes["user_agent.original"] = agent;
      const span = tracer.startSpan(method, { kind: api.SpanKind.SERVER, attributes }, parent);
      return api.context.with(api.trace.setSpan(parent, span), () => fn(span));
    },
  };
}

/** Client spans for calls Inferlo makes: AI models and the database. */
export interface ClientTracing {
  /** Starts a client span under the active one. The caller ends it (with end or fail). */
  start(name: string, attributes: Attributes): OtelSpan;
  /** Runs fn inside a client span that is active while fn runs, and ends it; errors are recorded on it. */
  run<T>(name: string, attributes: Attributes, fn: (span: OtelSpan) => Promise<T>): Promise<T>;
  /** Records an error on a span and ends it. */
  fail(span: OtelSpan, error: unknown): void;
  /** True while a span (a request's or a job's) is active. */
  inSpan(): boolean;
}

export function clientTracing(config: TracingConfig, defaultName: string, version?: string): ClientTracing {
  const api = config.api;
  const tracer = api.trace.getTracer(config.tracerName ?? defaultName, version);
  const kind = api.SpanKind.CLIENT ?? CLIENT_KIND;
  const fail = (span: OtelSpan, error: unknown) => {
    span.recordException(error instanceof Error ? error : String(error));
    const code = (error as { code?: unknown })?.code;
    if (typeof code === "string") span.setAttribute("error.type", code);
    else span.setAttribute("error.type", error instanceof Error ? error.name : "Error");
    span.setStatus({ code: api.SpanStatusCode.ERROR });
    span.end();
  };
  const start = (name: string, attributes: Attributes) => tracer.startSpan(name, { kind, attributes }, api.context.active());
  return {
    start,
    fail,
    async run(name, attributes, fn) {
      const span = start(name, attributes);
      let result;
      try {
        result = await api.context.with(api.trace.setSpan(api.context.active(), span), () => fn(span));
      } catch (error) {
        fail(span, error);
        throw error;
      }
      span.end();
      return result;
    },
    inSpan() {
      if (!api.trace.getSpan) return true;
      const active = api.trace.getSpan(api.context.active());
      return active !== undefined && active.spanContext().traceId !== INVALID_TRACE;
    },
  };
}

const SQL_OPERATION = /^\s*([a-z]+)/i;

/**
 * Wraps a database adapter so its queries get client spans ("SELECT tickets") while a request or job is traced.
 * Queries outside a trace (startup, the job worker polling for work) are not traced. Values are never recorded,
 * only the parameterised SQL of raw queries.
 */
export function traceAdapter(adapter: Adapter, tracing: ClientTracing): Adapter {
  const system = adapter.dialect === "postgres" ? "postgresql" : adapter.dialect;
  const traced = <T>(operation: string, table: string | undefined, query: string | undefined, fn: () => Promise<T>): Promise<T> => {
    if (!tracing.inSpan()) return fn();
    const attributes: Attributes = { "db.system.name": system, "db.operation.name": operation };
    if (table) attributes["db.collection.name"] = table;
    if (query) attributes["db.query.text"] = query;
    return tracing.run(table ? `${operation} ${table}` : operation, attributes, fn);
  };
  const wrapped: Adapter = {
    ...adapter,
    insert: (model, row) => traced("INSERT", model.name, undefined, () => adapter.insert(model, row)),
    select: (model, query) => traced("SELECT", model.name, undefined, () => adapter.select(model, query)),
    update: (model, where, patch) => traced("UPDATE", model.name, undefined, () => adapter.update(model, where, patch)),
    delete: (model, where) => traced("DELETE", model.name, undefined, () => adapter.delete(model, where)),
    count: (model, where) => traced("COUNT", model.name, undefined, () => adapter.count(model, where)),
  };
  if (adapter.transaction) wrapped.transaction = (fn) => adapter.transaction!((tx) => fn(traceAdapter(tx, tracing)));
  if (adapter.sql) {
    wrapped.sql = (text, params) => traced((SQL_OPERATION.exec(text)?.[1] ?? "SQL").toUpperCase(), undefined, text, () => adapter.sql!(text, params));
  }
  return wrapped;
}

/** traceId and spanId for log entries, when the span belongs to a real trace. */
export function traceFields(span: OtelSpan | undefined): { traceId?: string; spanId?: string } {
  const context = span?.spanContext();
  if (!context || context.traceId === INVALID_TRACE) return {};
  return { traceId: context.traceId, spanId: context.spanId };
}
