// Inferlo's AI module inside an Encore service: one client, created once at startup, with the API key from
// an Encore secret (set it with `encore secret set --type dev,local,pr,prod AnthropicApiKey`).
import { secret } from "encore.dev/config";
import { anthropic, createAI, type AIConfig } from "../../../src/ai/public.ts";

const anthropicApiKey = secret("AnthropicApiKey");

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: anthropicApiKey() }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export const ai = createAI(aiConfig);
