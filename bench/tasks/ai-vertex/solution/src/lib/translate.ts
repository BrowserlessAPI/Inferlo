import { createAI, env, t, vertexAI } from "@browserlessapi/inferlo/ai";

export async function getAccessToken(): Promise<string> {
  return env("GCP_ACCESS_TOKEN");
}

export const ai = createAI({
  providers: { vertex: vertexAI({ project: env("GCP_PROJECT"), location: "europe-west4", token: getAccessToken }) },
  models: { fast: "vertex:google/gemini-2.5-flash" },
});

const Translation = t.object({ translation: t.string() });

export async function translate(text: string, language: string, userId: string): Promise<{ translation: string }> {
  const { object } = await ai.generate({ model: "fast", system: `Translate the user's text into ${language}.`, prompt: text, output: Translation, for: userId });
  return object;
}
