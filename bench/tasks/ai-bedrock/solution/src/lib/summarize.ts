import { bedrock, createAI, env, t } from "@browserlessapi/inferlo/ai";

export const ai = createAI({
  providers: {
    bedrock: bedrock({
      region: "eu-central-1",
      credentials: { accessKeyId: env("AWS_ACCESS_KEY_ID"), secretAccessKey: env("AWS_SECRET_ACCESS_KEY"), sessionToken: env("AWS_SESSION_TOKEN") },
    }),
  },
  models: { fast: "bedrock:eu.anthropic.claude-haiku-4-5-20251001-v1:0", embed: "bedrock:amazon.titan-embed-text-v2:0" },
});

const Summary = t.object({ summary: t.string(), keywords: t.array(t.string()) });

export async function summarize(text: string, userId: string): Promise<{ summary: string; keywords: string[] }> {
  const { object } = await ai.generate({ model: "fast", system: "Summarize the text in two sentences and list its keywords.", prompt: text, output: Summary, for: userId });
  return object;
}

export async function embedText(text: string): Promise<number[]> {
  const { embeddings } = await ai.embed({ model: "embed", input: text });
  return embeddings[0]!;
}
