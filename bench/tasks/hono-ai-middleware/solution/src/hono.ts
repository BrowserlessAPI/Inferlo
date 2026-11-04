import { Hono } from "hono";
import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";
import { inferloAI, type InferloVariables } from "@browserlessapi/inferlo/hono";
import { app } from "./app.ts";

const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

export const hono = new Hono<{ Variables: InferloVariables }>();
hono.use(inferloAI(ai));

hono.post("/translate", async (c) => {
  const { text, to } = await c.req.json<{ text: string; to: string }>();
  const result = await c.var.ai.generate({ model: "fast", prompt: `Translate into ${to}. Reply with the translation only.\n\n${text}` });
  return c.json({ translation: result.text });
});

hono.mount("/api", app.fetch);
