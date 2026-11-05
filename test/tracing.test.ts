import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { after, before, describe, test } from "node:test";
import * as otel from "@opentelemetry/api";
import { createAI, mockProvider, ProviderError } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, memory, model, route, t, type Adapter } from "../src/index.ts";
import { clientTracing, traceAdapter } from "../src/tracing.ts";

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


const Note = model("notes", { title: t.string().min(1) });

function aiApp() {
  const failing = mockProvider({
    name: "openai",
    respond: () => {
      throw new ProviderError("openai", 503, "overloaded");
    },
  });
  const routes = {
    summarize: route.post("/summaries", { auth: "public", body: t.object({ text: t.string() }) }).handle(async ({ body, ai, db }) => {
      await (db as any).notes.insert({ title: body.text });
      const { text } = await ai.generate({ model: "fast", prompt: body.text, maxTokens: 100 });
      return { summary: text, notes: await (db as any).notes.count() };
    }),
    fallback: route.get("/fallback", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "backup", prompt: "hi" })).text),
    broken: route.get("/ai-broken", { auth: "public" }).handle(async ({ ai }) => (await ai.generate({ model: "openai:gpt-5-mini", prompt: "hi" })).text),
    chat: route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "hello there" }).toResponse()),
    embed: route.get("/embed", { auth: "public" }).handle(async ({ ai }) => (await ai.embed({ model: "mock:embedder", input: ["a", "b"] })).embeddings.length),
  };
  return createApp({
    name: "traced-ai",
    models: [Note],
    db: memory(),
    routes: [routes],
    tracing: { api: otel },
    ai: {
      providers: { mock: mockProvider({ name: "anthropic", respond: () => "A short summary." }), openai: failing },
      models: { fast: "mock:claude-haiku-4-5", backup: ["openai:gpt-5-mini", "mock:claude-haiku-4-5"] },
      pricing: { "mock:claude-haiku-4-5": { input: 1, output: 5 } },
    },
  });
}

describe("tracing AI calls and database queries", () => {
  test("AI calls get a client span under the request's span with the model, tokens and cost", async () => {
    spans.length = 0;
    const res = await aiApp().fetch(new Request("http://localhost/summaries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Long text to summarize" }) }));
    assert.equal(res.status, 200);
    const server = spans.find((s) => s.kind === otel.SpanKind.SERVER)!;
    const ai = spans.find((s) => s.name === "chat claude-haiku-4-5")!;
    assert.ok(ai, "AI span");
    assert.equal(ai.kind, otel.SpanKind.CLIENT);
    assert.equal(ai.parentSpanId, server.context.spanId);
    assert.equal(ai.context.traceId, server.context.traceId);
    assert.ok(ai.ended);
    assert.deepEqual(ai.attributes, {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-haiku-4-5",
      "gen_ai.request.max_tokens": 100,
      "inferlo.ai.model": "fast",
      "gen_ai.response.model": "claude-haiku-4-5",
      "gen_ai.usage.input_tokens": 6,
      "gen_ai.usage.output_tokens": 4,
      "inferlo.ai.cost_usd": (6 * 1 + 4 * 5) / 1_000_000,
      "inferlo.ai.steps": 1,
    });
    assert.ok(!JSON.stringify(spans.map((s) => s.attributes)).includes("Long text"), "prompts and answers are never recorded");
  });

  test("database queries in a request get client spans with the table and operation", async () => {
    spans.length = 0;
    const app = aiApp();
    await app.fetch(new Request("http://localhost/summaries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) }));
    const server = spans.find((s) => s.kind === otel.SpanKind.SERVER)!;
    const insert = spans.find((s) => s.name === "INSERT notes")!;
    const count = spans.find((s) => s.name === "COUNT notes")!;
    assert.deepEqual(insert.attributes, { "db.system.name": "memory", "db.operation.name": "INSERT", "db.collection.name": "notes" });
    assert.equal(insert.kind, otel.SpanKind.CLIENT);
    assert.equal(insert.parentSpanId, server.context.spanId);
    assert.ok(insert.ended && count.ended);
    assert.ok(!JSON.stringify(insert.attributes).includes('"x"'), "values are never recorded");

    spans.length = 0;
    assert.equal(await app.db.notes.count(), 1);
    assert.equal(spans.length, 0, "queries outside a traced request or job are not traced");
  });

  test("fallback records the model that answered; failed calls record the error", async () => {
    spans.length = 0;
    const app = aiApp();
    assert.equal((await app.fetch(new Request("http://localhost/fallback"))).status, 200);
    const fallback = spans.find((s) => s.name === "chat gpt-5-mini")!;
    assert.equal(fallback.attributes["gen_ai.request.model"], "gpt-5-mini");
    assert.equal(fallback.attributes["gen_ai.response.model"], "claude-haiku-4-5");
    assert.equal(fallback.attributes["gen_ai.provider.name"], "anthropic");
    assert.equal(fallback.status.code, otel.SpanStatusCode.UNSET);

    spans.length = 0;
    assert.equal((await app.fetch(new Request("http://localhost/ai-broken"))).status, 502);
    const failed = spans.find((s) => s.name === "chat gpt-5-mini")!;
    assert.equal(failed.status.code, otel.SpanStatusCode.ERROR);
    assert.equal(failed.attributes["error.type"], "IL5003", "every model failed");
    assert.equal(failed.exceptions.length, 1);
    assert.ok(failed.ended);
  });

  test("streams get a span that ends when the stream does, with the usage", async () => {
    spans.length = 0;
    const res = await aiApp().fetch(new Request("http://localhost/chat"));
    assert.match(await res.text(), /event: done/);
    const stream = spans.find((s) => s.name === "chat claude-haiku-4-5")!;
    assert.equal(stream.attributes["inferlo.ai.stream"], true);
    assert.equal(stream.attributes["gen_ai.usage.output_tokens"], 4);
    assert.ok(stream.ended);

    spans.length = 0;
    const cancelled = await aiApp().fetch(new Request("http://localhost/chat"));
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const span = spans.find((s) => s.name === "chat claude-haiku-4-5")!;
    assert.ok(span.ended, "a cancelled stream still ends its span");
    assert.equal(span.attributes["inferlo.ai.cancelled"], true);
  });

  test("embeddings get an embeddings span", async () => {
    spans.length = 0;
    await aiApp().fetch(new Request("http://localhost/embed"));
    const span = spans.find((s) => s.name === "embeddings embedder")!;
    assert.equal(span.attributes["gen_ai.operation.name"], "embeddings");
    assert.equal(span.attributes["gen_ai.usage.input_tokens"], 1);
    assert.equal(span.attributes["gen_ai.response.model"], "embedder");
  });

  test("createAI({ tracing }) traces AI calls without an app; invalid options raise IL6030", async () => {
    spans.length = 0;
    const ai = createAI({ providers: { mock: mockProvider({ respond: () => "ok" }) }, models: { fast: "mock:m" }, tracing: { api: otel } });
    await ai.generate({ model: "fast", prompt: "hi" });
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.name, "chat m");
    assert.equal(spans[0]!.parentSpanId, undefined);
    assert.throws(() => createAI({ providers: {}, tracing: {} as never }), (e: unknown) => e instanceof InferloError && e.code === "IL6030" && /createAI/.test(e.fix ?? ""));
  });

  test("raw SQL gets a span with the parameterised query, never the values", async () => {
    const calls: unknown[][] = [];
    const fake: Adapter = { ...memory(), dialect: "postgres", sql: async (text, params) => (calls.push([text, params]), []) };
    const traced = traceAdapter(fake, clientTracing({ api: otel }, "test"));
    spans.length = 0;
    await traced.sql!("select 1");
    assert.equal(spans.length, 0, "no span outside a trace");
    const parent = tracer.startSpan("job");
    await otel.context.with(otel.trace.setSpan(otel.context.active(), parent as unknown as otel.Span), () => traced.sql!("  update notes set title = $1 where id = $2", ["secret", 1]));
    const span = spans.find((s) => s.name === "UPDATE")!;
    assert.deepEqual(span.attributes, { "db.system.name": "postgresql", "db.operation.name": "UPDATE", "db.query.text": "  update notes set title = $1 where id = $2" });
    assert.equal(span.parentSpanId, parent.context.spanId);
    assert.deepEqual(calls.at(-1), ["  update notes set title = $1 where id = $2", ["secret", 1]]);
  });
});
