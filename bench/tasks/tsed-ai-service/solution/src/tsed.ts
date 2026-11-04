import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";
import { InferloAI, inferloAI } from "@browserlessapi/inferlo/tsed";

const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

// Services inject it with constructor(private readonly ai: InferloAI) {} or inject(AI_TOKEN).
export const AI_TOKEN = InferloAI;

export const aiProviders = [inferloAI(ai)];
