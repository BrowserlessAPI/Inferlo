import Fastify from "fastify";
import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";
import { inferloPlugin } from "@browserlessapi/inferlo/fastify";
import { app } from "./app.ts";

const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

export async function buildServer() {
  const fastify = Fastify();
  await fastify.register(inferloPlugin, { ai });
  // The Inferlo app: /api/notes, /api/health, /api/openapi.json.
  await fastify.register(inferloPlugin, { app, prefix: "/api" });

  fastify.post<{ Body: { text: string; to: string } }>("/translate", async (request) => {
    const { text, to } = request.body;
    const result = await request.ai.generate({ model: "fast", prompt: `Translate into ${to}. Reply with the translation only.\n\n${text}` });
    return { translation: result.text };
  });
  return fastify;
}
