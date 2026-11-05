// An existing Nitro server route that uses the AI client from the plugin, with structured output.
import { defineEventHandler, readBody } from "h3";
import { t } from "../../../../src/ai/public.ts";

const Label = t.object({ label: t.enum(["bug", "question", "feature"]) });

export default defineEventHandler(async (event) => {
  const body = (await readBody<{ text?: string }>(event)) ?? {};
  const { object } = await event.context.ai.generate({ model: "fast", prompt: `Classify this support message:\n\n${body.text ?? ""}`, output: Label });
  return object;
});
