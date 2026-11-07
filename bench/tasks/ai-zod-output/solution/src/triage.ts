import type { AI } from "@browserlessapi/inferlo/ai";
import { z } from "zod";

export const triageSchema = z.object({
  priority: z.enum(["low", "normal", "urgent"]),
  tags: z.array(z.string()).max(5),
});

export async function triage(ai: AI, text: string) {
  const { object } = await ai.generate({
    model: "fast",
    system: "Triage the support ticket: choose a priority and up to 5 short tags.",
    prompt: text,
    output: triageSchema,
  });
  return object;
}
