/** Shared by the framework integrations: checks that a value is an AI client (createAI(...) or app.ai). */
import type { AI } from "./ai/index.ts";
import { InferloError } from "./errors.ts";

export function assertAIClient(ai: unknown, fix: string): asserts ai is AI {
  const candidate = ai as Partial<AI> | undefined;
  if (!candidate || typeof candidate.generate !== "function" || typeof candidate.stream !== "function" || typeof candidate.embed !== "function") {
    throw new InferloError("IL5014", "inferloAI() needs an AI client.", { fix });
  }
}
