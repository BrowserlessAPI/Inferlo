// The AI module for loaders and actions: no app, router or database needed. The .server.ts name keeps it (and
// the API key) out of the browser bundle.
import { anthropic, createAI, env, type AIConfig } from "../../../../src/ai/public.ts";

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export const ai = createAI(aiConfig);
