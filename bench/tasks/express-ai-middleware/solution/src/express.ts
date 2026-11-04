import express from "express";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { anthropic, createAI, env } from "@browserlessapi/inferlo/ai";
import { inferloAI } from "@browserlessapi/inferlo/express";
import { app } from "./app.ts";

const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

export const server = express();
server.use(express.json());
server.use(inferloAI(ai));

server.post("/translate", async (req, res) => {
  const { text, to } = req.body as { text: string; to: string };
  const result = await req.ai.generate({ model: "fast", prompt: `Translate into ${to}. Reply with the translation only.\n\n${text}` });
  res.json({ translation: result.text });
});

// The Inferlo app: /api/notes, /api/health, /api/openapi.json.
server.use("/api", toNodeHandler(app));
