import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as otel from "@opentelemetry/api";

test("every AI call made with the standalone client gets a span with the model and tokens", async () => {
  const source = readFileSync(new URL("../src/lib/ai.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/ai/, "uses the standalone AI module");
  const spans: { name: string; attributes: Record<string, unknown>; ended: boolean }[] = [];
  const tracer = {
    startSpan(name: string, options: otel.SpanOptions = {}) {
      const span = { name, attributes: { ...options.attributes } as Record<string, unknown>, ended: false };
      spans.push(span);
      return {
        spanContext: () => ({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1 }),
        setAttribute: (key: string, value: unknown) => void (span.attributes[key] = value),
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
  // The Anthropic API, answering every request.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: "Report ready." }], usage: { input_tokens: 12, output_tokens: 3 } }), { headers: { "content-type": "application/json" } });
  const { ai } = await import("../src/lib/ai.ts");
  const { text } = await ai.generate({ model: "fast", prompt: "Summarize the night." });
  assert.equal(text, "Report ready.");
  const span = spans.find((s) => s.name === "chat claude-haiku-4-5");
  assert.ok(span, "a span for the AI call");
  assert.equal(span.attributes["gen_ai.provider.name"], "anthropic");
  assert.equal(span.attributes["gen_ai.usage.input_tokens"], 12);
  assert.equal(span.attributes["gen_ai.usage.output_tokens"], 3);
  assert.ok(span.ended);
});
