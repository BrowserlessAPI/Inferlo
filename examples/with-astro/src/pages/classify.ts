// An Astro endpoint that uses context.locals.ai (set by src/middleware.ts) with structured output.
import type { APIRoute } from "astro";
import { t } from "../../../../src/ai/public.ts";

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const text = String((await request.formData()).get("text") ?? "").trim();
  if (!text) return Response.json({ error: "Enter a message." }, { status: 400 });
  const { object } = await locals.ai.generate({ model: "fast", system: "Classify the customer message.", prompt: text, output: Label });
  return Response.json(object);
};
