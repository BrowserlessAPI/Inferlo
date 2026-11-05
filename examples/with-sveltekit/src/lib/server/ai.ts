// The AI module for load functions, form actions and +server.ts files: no app, router or database needed.
// It lives in src/lib/server so SvelteKit never bundles it (or the API key) for the browser.
import { anthropic, createAI, env, type AIConfig } from "../../../../../src/ai/public.ts";

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export const ai = createAI(aiConfig);
