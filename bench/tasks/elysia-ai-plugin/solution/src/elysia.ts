import { Elysia } from "elysia";
import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";
import { inferloAI } from "@browserlessapi/inferlo/elysia";
import { app } from "./app.ts";

const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

export const elysia = new Elysia()
  .use(inferloAI(ai))
  .post("/translate", async ({ ai, body }) => {
    const { text, to } = body as { text: string; to: string };
    const result = await ai.generate({ model: "fast", prompt: `Translate into ${to}. Reply with the translation only.\n\n${text}` });
    return { translation: result.text };
  })
  .mount("/api", app.fetch);
