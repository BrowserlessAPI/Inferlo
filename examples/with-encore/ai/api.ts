// Encore endpoints of the "ai" service.
// 1. A typed Encore endpoint that calls Inferlo's AI module with structured output.
// 2. A raw Encore endpoint that serves the Inferlo app in inferlo.ts under /inferlo.
import { api } from "encore.dev/api";
import { t } from "../../../src/ai/public.ts";
import { toNodeHandler } from "../../../src/index.ts";
import { ai } from "./ai.ts";
import { inferlo } from "./inferlo.ts";

interface ClassifyRequest {
  text: string;
}

interface ClassifyResponse {
  label: "bug" | "feature" | "question";
}

export const classify = api(
  { expose: true, method: "POST", path: "/classify" },
  async ({ text }: ClassifyRequest): Promise<ClassifyResponse> => {
    const { object } = await ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature", "question"]) }) });
    return object;
  },
);

// Every method and path under /inferlo goes to the Inferlo app, which does its own auth, so the endpoint
// itself is public to Encore. The prefix is removed before routing: POST /inferlo/summaries runs
// route.post("/summaries"), and the OpenAPI document is at /inferlo/openapi.json.
export const inferloApp = api.raw({ expose: true, method: "*", path: "/inferlo/*rest" }, toNodeHandler(inferlo, { prefix: "/inferlo" }));
