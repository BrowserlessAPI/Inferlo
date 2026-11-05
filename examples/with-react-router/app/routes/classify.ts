// A page route whose loader and action call the AI module directly, with structured output.
// Declared in app/routes.ts as route("classify", "routes/classify.ts"); the page component is left out here.
import { data, type ActionFunctionArgs } from "react-router";
import { t, type AI } from "../../../../src/ai/public.ts";
import { ai as sharedAI } from "../lib/ai.server.ts";

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

/** Loader and action for any AI client: the route uses the shared one, tests pass a mock. */
export function classifyRoute(ai: AI) {
  return {
    async loader() {
      const { text } = await ai.generate({ model: "fast", prompt: "Write a one-line greeting for a support form." });
      return { greeting: text };
    },
    async action({ request }: ActionFunctionArgs) {
      const text = String((await request.formData()).get("text") ?? "").trim();
      if (!text) return data({ error: "Enter a message." }, { status: 400 });
      const { object } = await ai.generate({ model: "fast", system: "Classify the customer message.", prompt: text, output: Label });
      return object;
    },
  };
}

export const { loader, action } = classifyRoute(sharedAI);
