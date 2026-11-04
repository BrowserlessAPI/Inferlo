import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";
import { INFERLO_AI, InferloModule } from "@browserlessapi/inferlo/nestjs";

const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

// Services inject it with constructor(@Inject(AI_TOKEN) private readonly ai: AI) {}.
export const AI_TOKEN = INFERLO_AI;

export const aiModule = InferloModule.forRoot({ ai });
