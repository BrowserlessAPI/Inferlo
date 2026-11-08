// The AI module for server functions and server routes: no app, router or database needed. Import it only from
// server code (server routes, createServerFn handlers), so the API key never reaches the browser bundle.
import { anthropic, createAI, env, type AIConfig } from "../../../../src/ai/public.ts";

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export const ai = createAI(aiConfig);
