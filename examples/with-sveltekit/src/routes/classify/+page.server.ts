// A SvelteKit page whose load function and form action use event.locals.ai, with structured output.
import { fail, type Actions, type ServerLoad } from "@sveltejs/kit";
import { t } from "../../../../../src/ai/public.ts";

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

export const load: ServerLoad = async ({ locals }) => {
  const { text } = await locals.ai.generate({ model: "fast", prompt: "Write a one-line greeting for a support form." });
  return { greeting: text };
};

export const actions = {
  default: async ({ request, locals }) => {
    const text = String((await request.formData()).get("text") ?? "").trim();
    if (!text) return fail(400, { error: "Enter a message." });
    const { object } = await locals.ai.generate({ model: "fast", system: "Classify the customer message.", prompt: text, output: Label });
    return object;
  },
} satisfies Actions;
