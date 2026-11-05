import assert from "node:assert/strict";
import { test } from "node:test";
import * as otel from "@opentelemetry/api";

test("every request gets a server span named after its route", async () => {
  const spans: { name: string; kind?: number; attributes: Record<string, unknown>; ended: boolean }[] = [];
  const tracer = {
    startSpan(name: string, options: otel.SpanOptions = {}) {
      const span = { name, kind: options.kind, attributes: { ...options.attributes } as Record<string, unknown>, ended: false };
      spans.push(span);
      return {
        spanContext: () => ({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1 }),
        setAttribute: (key: string, value: unknown) => void (span.attributes[key] = value),
        setAttributes: () => {},
        setStatus: () => {},
        updateName: (next: string) => void (span.name = next),
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
  const { app } = await import("../src/app.ts");
  const res = await app.fetch(new Request("http://localhost/notes"));
  assert.equal(res.status, 401);
  const server = spans.find((s) => s.kind === otel.SpanKind.SERVER);
  assert.ok(server, "a server span for the request");
  assert.equal(server.name, "GET /notes");
  assert.equal(server.attributes["http.response.status_code"], 401);
  assert.ok(server.ended);
});
