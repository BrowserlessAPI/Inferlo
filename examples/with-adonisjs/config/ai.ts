// The AI client the Inferlo provider binds. In your app, import from "@browserlessapi/inferlo/ai"
// and read the key with env.get("ANTHROPIC_API_KEY") from #start/env.
import { anthropic, createAI, env } from "../../../src/ai/public.ts";

export default createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});
