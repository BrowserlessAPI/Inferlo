import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { after, before, describe, test } from "node:test";
import * as otel from "@opentelemetry/api";
import { bearer, createApp, InferloError, route, t } from "../src/index.ts";

// A minimal OpenTelemetry SDK for the test: an AsyncLocalStorage context manager, the W3C traceparent propagator and
// a tracer that records spans. Real apps use @opentelemetry/sdk-node or another SDK.
class TestSpan {
  attributes: Record<string, unknown>;
  status: { code: number; message?: string } = { code: 0 };
  exceptions: unknown[] = [];
  ended = false;
  name: string;
  readonly kind: number | undefined;
  readonly parentSpanId: string | undefined;
  readonly context: otel.SpanContext;
  constructor(name: string, options: otel.SpanOptions, parent: otel.SpanContext | undefined) {
    this.name = name;
    this.kind = options.kind;
    this.attributes = { ...options.attributes };
    this.parentSpanId = parent?.spanId;
    this.context = { traceId: parent?.traceId ?? hex(16), spanId: hex(8), traceFlags: 1 };
  }
  spanContext() { return this.context; }
  setAttribute(key: string, value: unknown) { this.attributes[key] = value; return this; }
  setAttributes(values: Record<string, unknown>) { Object.assign(this.attributes, values); return this; }
  addEvent() { return this; }
  addLink() { return this; }
  addLinks() { return this; }
  setStatus(status: { code: number; message?: string }) { this.status = status; return this; }
  updateName(name: string) { this.name = name; return this; }
  end() { this.ended = true; }
  isRecording() { return !this.ended; }
  recordException(exception: unknown) { this.exceptions.push(exception); }
}
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

const spans: TestSpan[] = [];
const tracer = {
  startSpan(name: string, options: otel.SpanOptions = {}, ctx?: otel.Context) {
    const span = new TestSpan(name, options, otel.trace.getSpanContext(ctx ?? otel.context.active()));
    spans.push(span);
    return span;
  },
  startActiveSpan() { throw new Error("not used"); },
};
const storage = new AsyncLocalStorage<otel.Context>();
const contextManager: otel.ContextManager = {
  active: () => storage.getStore() ?? otel.ROOT_CONTEXT,
  with: (ctx, fn, thisArg, ...args) => storage.run(ctx, () => fn.call(thisArg, ...args)),
  bind: (_ctx, target) => target,
  enable() { return this; },
  disable() { return this; },
};
const propagator: otel.TextMapPropagator = {
  inject() {},
  extract(ctx, carrier, getter) {
    const value = getter.get(carrier, "traceparent");
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(String(Array.isArray(value) ? value[0] : value ?? ""));
    if (!match) return ctx;
    return otel.trace.setSpanContext(ctx, { traceId: match[1]!, spanId: match[2]!, traceFlags: parseInt(match[3]!, 16), isRemote: true });
  },
  fields: () => ["traceparent"],
};

before(() => {
  otel.context.setGlobalContextManager(contextManager);
  otel.propagation.setGlobalPropagator(propagator);
  otel.trace.setGlobalTracerProvider({ getTracer: () => tracer as unknown as otel.Tracer });
});
after(() => {
  otel.trace.disable();
  otel.propagation.disable();
  otel.context.disable();
});

const users = new Map([["demo", { id: "u1", roles: [] as string[] }]]);
function makeApp(entries: { level: string; message: string; fields?: Record<string, unknown> }[] = []) {
  let inner: otel.Span | undefined;
  const routes = {
    getItem: route.get("/items/:id", { auth: "public", params: t.object({ id: t.string() }) }).handle(({ params }) => {
      // Spans started in the handler (by you or by instrumentations) are children of the request's span.
      const child = otel.trace.getTracer("test").startSpan("load item");
      child.end();
      inner = otel.trace.getActiveSpan();
      return { id: params.id };
    }),
    broken: route.get("/broken", { auth: "public" }).handle(() => {
      throw new Error("boom");
    }),
    secret: route.get("/secret").handle(() => ({ ok: true })),
  };
  const logger = {
    info: (message: string, _data?: unknown, fields?: Record<string, unknown>) => void entries.push({ level: "info", message, fields }),
    error: (message: string, _data?: unknown, fields?: Record<string, unknown>) => void entries.push({ level: "error", message, fields }),
  };
  const app = createApp({ name: "traced", version: "1.2.3", routes: [routes], auth: bearer((token) => users.get(token) ?? null), tracing: { api: otel }, logger, logging: { requests: true }, health: true });
  return { app, entries, inner: () => inner };
}

describe("tracing", () => {
  test("each request gets an ended server span named after its route, with HTTP attributes", async () => {
    spans.length = 0;
    const { app, inner } = makeApp();
    const res = await app.fetch(new Request("https://api.example.com:8443/items/42", { headers: { "user-agent": "test-agent" } }));
    assert.equal(res.status, 200);
    const [server, child] = spans;
    assert.equal(spans.length, 2);
    assert.equal(server!.name, "GET /items/:id");
    assert.equal(server!.kind, otel.SpanKind.SERVER);
    assert.deepEqual(server!.attributes, {
      "http.request.method": "GET",
      "url.path": "/items/42",
      "url.scheme": "https",
      "server.address": "api.example.com",
      "server.port": 8443,
      "user_agent.original": "test-agent",
      "http.route": "/items/:id",
      "http.response.status_code": 200,
    });
    assert.equal(server!.status.code, otel.SpanStatusCode.UNSET);
    assert.ok(server!.ended);
    assert.equal(inner(), server, "the request's span is active in the handler");
    assert.equal(child!.parentSpanId, server!.context.spanId);
    assert.equal(child!.context.traceId, server!.context.traceId);
  });

  test("continues the caller's trace from the traceparent header", async () => {
    spans.length = 0;
    const { app } = makeApp();
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    await app.fetch(new Request("http://localhost/items/1", { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } }));
    assert.equal(spans[0]!.context.traceId, traceId);
    assert.equal(spans[0]!.parentSpanId, "00f067aa0ba902b7");
  });

  test("server errors set the error status and record the exception; client errors do not", async () => {
    spans.length = 0;
    const { app } = makeApp();
    assert.equal((await app.fetch(new Request("http://localhost/broken"))).status, 500);
    const failed = spans[0]!;
    assert.equal(failed.name, "GET /broken");
    assert.equal(failed.status.code, otel.SpanStatusCode.ERROR);
    assert.equal(failed.attributes["http.response.status_code"], 500);
    assert.equal((failed.exceptions[0] as Error).message, "boom");

    spans.length = 0;
    assert.equal((await app.fetch(new Request("http://localhost/secret"))).status, 401);
    assert.equal(spans[0]!.status.code, otel.SpanStatusCode.UNSET);
    assert.deepEqual(spans[0]!.exceptions, []);
    spans.length = 0;
    assert.equal((await app.fetch(new Request("http://localhost/nothing-here"))).status, 404);
    assert.equal(spans[0]!.name, "GET", "unmatched requests keep the method as the name (low cardinality)");
    assert.equal(spans[0]!.attributes["http.route"], undefined);
  });

  test("request logs and error logs carry traceId and spanId", async () => {
    spans.length = 0;
    const { app, entries } = makeApp();
    await app.fetch(new Request("http://localhost/items/1"));
    await app.fetch(new Request("http://localhost/broken"));
    const [first, second] = [spans[0]!, spans.find((s) => s.name === "GET /broken")!];
    const request = entries.find((e) => e.message.startsWith("GET /items/1 200"))!;
    assert.equal(request.fields!.traceId, first.context.traceId);
    assert.equal(request.fields!.spanId, first.context.spanId);
    const error = entries.find((e) => e.level === "error")!;
    assert.equal(error.fields!.traceId, second.context.traceId);
    assert.equal(error.fields!.spanId, second.context.spanId);
  });

  test("health and readiness probes are not traced", async () => {
    spans.length = 0;
    const { app } = makeApp();
    assert.equal((await app.fetch(new Request("http://localhost/health"))).status, 200);
    assert.equal((await app.fetch(new Request("http://localhost/ready"))).status, 200);
    assert.equal(spans.length, 0);
  });

  test("invalid tracing options raise IL6030", () => {
    const fails = (tracing: unknown) =>
      assert.throws(() => createApp({ routes: [], tracing: tracing as never }), (e: unknown) => e instanceof InferloError && e.code === "IL6030");
    fails({});
    fails(null);
    fails({ api: {} });
    fails({ api: { ...otel, trace: {} } });
    fails({ api: otel, tracerName: "" });
    fails(otel);
  });

  test("without an SDK the API's no-op tracer is used: requests work and logs have no trace ids", async () => {
    otel.trace.disable();
    try {
      spans.length = 0;
      const { app, entries } = makeApp();
      assert.equal((await app.fetch(new Request("http://localhost/items/1"))).status, 200);
      assert.equal(spans.length, 0);
      const request = entries.find((e) => e.message.startsWith("GET /items/1 200"))!;
      assert.equal(request.fields!.traceId, undefined);
      assert.equal(request.fields!.requestId !== undefined, true);
    } finally {
      otel.trace.setGlobalTracerProvider({ getTracer: () => tracer as unknown as otel.Tracer });
    }
  });
});
