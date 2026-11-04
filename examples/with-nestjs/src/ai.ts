import { anthropic, createAI, env, type AIConfig } from "../../../src/ai/public.ts";

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export const makeAI = (config: AIConfig = aiConfig) => createAI(config);
