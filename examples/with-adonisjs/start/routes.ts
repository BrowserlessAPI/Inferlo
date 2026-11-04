import app from "@adonisjs/core/services/app";
import router from "@adonisjs/core/services/router";
import { t } from "../../../src/ai/public.ts";

router.use([() => import("@adonisjs/core/bodyparser_middleware")]);

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

// ctx.ai comes from the Inferlo provider: structured output with an Inferlo schema.
router.post("/classify", async ({ ai, request, response }) => {
  const text = request.input("text");
  if (typeof text !== "string" || !text.trim()) return response.unprocessableEntity({ error: "text is required" });
  const { object } = await ai.generate({ model: "fast", prompt: text, output: Label });
  return object;
});

// Outside an HTTP context (services, commands, jobs), resolve the client from the container.
export async function summarize(text: string): Promise<string> {
  const ai = await app.container.make("ai");
  const { text: summary } = await ai.generate({ model: "fast", prompt: `Summarize in one sentence:\n\n${text}` });
  return summary;
}

router.post("/summaries", async ({ request }) => ({ summary: await summarize(String(request.input("text") ?? "")) }));
