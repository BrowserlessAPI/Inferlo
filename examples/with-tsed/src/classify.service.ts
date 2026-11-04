import { Injectable } from "@tsed/di";
import { t } from "../../../src/ai/public.ts";
import { InferloAI } from "../../../src/tsed.ts";

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

@Injectable()
export class ClassifyService {
  // InferloAI is both the injection token and the type of the AI client.
  constructor(private readonly ai: InferloAI) {}

  async classify(text: string) {
    const { object } = await this.ai.generate({ model: "fast", prompt: text, output: Label });
    return object;
  }
}
