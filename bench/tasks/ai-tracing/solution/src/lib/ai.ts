import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";
import * as otel from "@opentelemetry/api";

export const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
  // A span per AI call (provider, model, tokens and cost), exported by the SDK the platform starts.
  tracing: { api: otel },
});
