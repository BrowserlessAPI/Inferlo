/**
 * OpenTelemetry tracing, with no dependency: pass the OpenTelemetry API you already use.
 *
 *   import * as otel from "@opentelemetry/api";
 *   createApp({ tracing: { api: otel } })
 *
 * Every request gets a server span ("GET /tickets/:id") that continues the caller's trace (W3C traceparent, through
 * the propagator your OpenTelemetry SDK registers), runs the handler inside it so spans you or instrumentations
 * start nest under it, and puts traceId and spanId on the request's log entries. Without an SDK, the API's
 * no-op tracer is used and nothing is recorded.
 */
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
  };
  context: { active(): unknown; with<T>(context: unknown, fn: () => T): T };
  propagation: { extract(context: unknown, carrier: unknown, getter?: unknown): unknown };
  SpanKind: { SERVER: number };
  SpanStatusCode: { ERROR: number };
}

export interface TracingConfig {
  /** The OpenTelemetry API: import * as otel from "@opentelemetry/api", then createApp({ tracing: { api: otel } }). */
  api: OtelApi;
  /** The tracer name. Default: the app's name. */
  tracerName?: string;
}

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

/** Checks createApp({ tracing }) and returns the request tracer, or undefined without tracing. */
export function requestTracing(option: unknown, appName: string, appVersion: string): RequestTracing | undefined {
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
      fix: 'Install @opentelemetry/api (and an OpenTelemetry SDK that exports the spans), then: import * as otel from "@opentelemetry/api"; createApp({ tracing: { api: otel } }).',
    });
  }
  const tracer = api!.trace.getTracer(config.tracerName ?? appName, appVersion);
  return {
    run(req, url, fn) {
      const method = req.method.toUpperCase();
      const parent = api!.propagation.extract(api!.context.active(), req.headers, headerGetter);
      const attributes: Record<string, string | number | boolean> = {
        "http.request.method": method,
        "url.path": url.pathname,
        "url.scheme": url.protocol.replace(/:$/, ""),
        "server.address": url.hostname,
      };
      if (url.port) attributes["server.port"] = Number(url.port);
      const agent = req.headers.get("user-agent");
      if (agent) attributes["user_agent.original"] = agent;
      const span = tracer.startSpan(method, { kind: api!.SpanKind.SERVER, attributes }, parent);
      return api!.context.with(api!.trace.setSpan(parent, span), () => fn(span));
    },
  };
}

/** traceId and spanId for log entries, when the span belongs to a real trace. */
export function traceFields(span: OtelSpan | undefined): { traceId?: string; spanId?: string } {
  const context = span?.spanContext();
  if (!context || context.traceId === INVALID_TRACE) return {};
  return { traceId: context.traceId, spanId: context.spanId };
}
