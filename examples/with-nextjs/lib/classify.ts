import { t, type AI } from "../../../src/ai/public.ts";

export const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

/** Structured output from any AI client: the server action passes the shared one, tests pass a mock. */
export async function classifyText(ai: AI, text: string): Promise<{ label: "bug" | "feature" | "question" }> {
  const { object } = await ai.generate({ model: "fast", system: "Classify the customer message.", prompt: text, output: Label });
  return object;
}
