import { Inject, Injectable } from "@nestjs/common";
import { t, type AI } from "../../../src/ai/public.ts";
import { INFERLO_AI } from "../../../src/nestjs.ts";

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

@Injectable()
export class ClassifyService {
  constructor(@Inject(INFERLO_AI) private readonly ai: AI) {}

  async classify(text: string) {
    const { object } = await this.ai.generate({ model: "fast", prompt: text, output: Label });
    return object;
  }
}
