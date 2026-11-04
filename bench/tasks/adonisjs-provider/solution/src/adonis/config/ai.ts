import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";

export default createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
