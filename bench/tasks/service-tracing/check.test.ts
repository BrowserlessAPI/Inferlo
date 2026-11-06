import assert from "node:assert/strict";
import { test } from "node:test";
import * as otel from "@opentelemetry/api";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";

test("calls to billing get a client span and send its traceparent", async () => {
  const spans: { name: string; kind?: number; spanId: string; ended: boolean }[] = [];
  let next = 0;
  const tracer = {
    startSpan(name: string, options: otel.SpanOptions = {}) {
      const spanId = (++next).toString(16).padStart(16, "0");
      const span = { name, kind: options.kind, spanId, ended: false };
      spans.push(span);
      return {
        spanContext: () => ({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId, traceFlags: 1 }),
        setAttribute: () => {},
        setAttributes: () => {},
        setStatus: () => {},
        updateName: () => {},
        recordException: () => {},
        addEvent: () => {},
        isRecording: () => true,
        end: () => void (span.ended = true),
      };
    },
    startActiveSpan() {
      throw new Error("not used");
    },
  };
  otel.trace.setGlobalTracerProvider({ getTracer: () => tracer as unknown as otel.Tracer });
  otel.propagation.setGlobalPropagator({
    inject(ctx, carrier, setter) {
      const span = otel.trace.getSpanContext(ctx);
      if (span) setter.set(carrier, "traceparent", `00-${span.traceId}-${span.spanId}-01`);
    },
    extract: (ctx) => ctx,
    fields: () => ["traceparent"],
  });
  const sent: (string | null)[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init).headers.get("traceparent"));
    return Response.json({ plan: "pro", renewsAt: null });
  }) as typeof fetch;
  try {
    const routes = await import("../src/routes/limits.ts");
    const app = createApp({ models, routes: [routes], db: memory(), auth: { resolve: () => null } });
    const user = await app.db.users.insert({ email: "p@x.io", name: "P" });
    const res = await app.request("/limits", { as: { id: user.id, email: user.email, name: user.name, roles: [] } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { plan: "pro", maxNotes: 1000 });
    const call = spans.find((s) => s.kind === otel.SpanKind.CLIENT);
    assert.ok(call, "a client span for the call to billing");
    assert.equal(call.name, "GET /accounts/:userId/plan");
    assert.ok(call.ended);
    assert.equal(sent[0], `00-4bf92f3577b34da6a3ce929d0e0e4736-${call.spanId}-01`, "the call sends the client span's traceparent");
  } finally {
    globalThis.fetch = realFetch;
    otel.trace.disable();
    otel.propagation.disable();
  }
});
