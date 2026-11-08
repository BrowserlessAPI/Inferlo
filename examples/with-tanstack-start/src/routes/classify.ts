// A server route that calls the AI module directly, with structured output. A page component can sit on the same
// route; it is left out here.
import { createFileRoute } from "@tanstack/react-router";
import { t, type AI } from "../../../../src/ai/public.ts";
import { ai as sharedAI } from "../lib/ai.ts";

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

/** The POST handler for any AI client: the route uses the shared one, tests pass a mock. */
export function classifyHandler(ai: AI) {
  return async ({ request }: { request: Request }) => {
    const form = await request.formData();
    const text = String(form.get("text") ?? "").trim();
    if (!text) return Response.json({ error: "Enter a message." }, { status: 400 });
    const { object } = await ai.generate({ model: "fast", system: "Classify the customer message.", prompt: text, output: Label });
    return Response.json(object);
  };
}

export const Route = createFileRoute("/classify")({
  server: { handlers: { POST: classifyHandler(sharedAI) } },
});
