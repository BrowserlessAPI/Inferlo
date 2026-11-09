import { azureOpenAI, createAI, env, mistral } from "@browserlessapi/inferlo/ai";

export const ai = createAI({
  providers: {
    azure: azureOpenAI({ resource: "contoso-eu", apiKey: env("AZURE_OPENAI_API_KEY") }),
    mistral: mistral({ apiKey: env("MISTRAL_API_KEY") }),
  },
  models: { fast: ["azure:gpt-5-mini-prod", "mistral:mistral-small-latest"] },
});

export async function summarize(text: string, userId: string): Promise<string> {
  const { text: summary } = await ai.generate({ model: "fast", system: "Summarize the text in one sentence.", prompt: text, for: userId });
  return summary;
}
