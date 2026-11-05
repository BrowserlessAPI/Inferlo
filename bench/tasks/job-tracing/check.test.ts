import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import * as otel from "@opentelemetry/api";

type Recorded = { name: string; kind?: number; traceId: string; spanId: string; parentSpanId?: string; ended: boolean };

test("a job runs in the trace of the request that enqueued it", async () => {
  const spans: Recorded[] = [];
  const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const tracer = {
    startSpan(name: string, options: otel.SpanOptions = {}, ctx?: otel.Context) {
      const parent = otel.trace.getSpanContext(ctx ?? otel.context.active());
      const span: Recorded = { name, kind: options.kind, traceId: parent?.traceId ?? hex(16), spanId: hex(8), parentSpanId: parent?.spanId, ended: false };
      spans.push(span);
      return {
        spanContext: () => ({ traceId: span.traceId, spanId: span.spanId, traceFlags: 1 }),
        setAttribute() {},
        setAttributes() {},
        setStatus() {},
        updateName: (next: string) => void (span.name = next),
        recordException() {},
        addEvent() {},
        isRecording: () => true,
        end: () => void (span.ended = true),
      };
    },
    startActiveSpan() {
      throw new Error("not used");
    },
  };
  const storage = new AsyncLocalStorage<otel.Context>();
  otel.context.setGlobalContextManager({
    active: () => storage.getStore() ?? otel.ROOT_CONTEXT,
    with: (ctx, fn, thisArg, ...args) => storage.run(ctx, () => fn.call(thisArg, ...args)),
    bind: (_ctx, target) => target,
    enable() { return this; },
    disable() { return this; },
  });
  otel.propagation.setGlobalPropagator({
    inject(ctx, carrier, setter) {
      const span = otel.trace.getSpanContext(ctx);
      if (span) setter.set(carrier, "traceparent", `00-${span.traceId}-${span.spanId}-01`);
    },
    extract(ctx, carrier, getter) {
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(String(getter.get(carrier, "traceparent") ?? ""));
      return match ? otel.trace.setSpanContext(ctx, { traceId: match[1]!, spanId: match[2]!, traceFlags: 1, isRemote: true }) : ctx;
    },
    fields: () => ["traceparent"],
  });
  otel.trace.setGlobalTracerProvider({ getTracer: () => tracer as unknown as otel.Tracer });

  const { app } = await import("../src/app.ts");
  const { sendDigest } = await import("../src/jobs.ts");
  // The request that enqueues the job (a span the platform's instrumentation would have started).
  const request = tracer.startSpan("POST /digests", { kind: otel.SpanKind.SERVER });
  const requestContext = otel.trace.setSpan(otel.context.active(), request as unknown as otel.Span);
  await otel.context.with(requestContext, () => app.jobs.enqueue(sendDigest, { userId: "00000000-0000-4000-8000-000000000001" }));
  request.end();
  const enqueuedIn = spans[0]!;

  assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
  const run = spans.find((s) => s.name.includes("send-digest"));
  assert.ok(run, "a span for the job run");
  assert.equal(run.traceId, enqueuedIn.traceId, "same trace as the request");
  assert.equal(run.parentSpanId, enqueuedIn.spanId);
  assert.ok(run.ended);
  assert.ok(spans.some((s) => s.parentSpanId === run.spanId && /notes/.test(s.name)), "the job's query is inside its span");
});
