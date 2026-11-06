// The AI module for pages, endpoints and actions: no app, router or database needed.
// It is only imported by server code (middleware and endpoints), so Astro never bundles it or the API key for the browser.
import { anthropic, createAI, env, type AIConfig } from "../../../../src/ai/public.ts";

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export const ai = createAI(aiConfig);
