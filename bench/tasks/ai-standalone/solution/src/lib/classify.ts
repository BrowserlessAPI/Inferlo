import { anthropic, createAI, env, t } from "@browserlessapi/inferlo/ai";

export const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

export async function classify(text: string, userId: string): Promise<"bug" | "feature" | "question"> {
  const { object } = await ai.generate({
    model: "fast",
    system: "Label the user's message as a bug report, a feature request or a question.",
    prompt: text,
    output: Label,
    for: userId,
  });
  return object.label;
}
