import { Controller } from "@tsed/di";
import { BodyParams } from "@tsed/platform-params";
import { Post } from "@tsed/schema";
import { ClassifyService } from "./classify.service.ts";

@Controller("/classify")
export class ClassifyController {
  constructor(private readonly classifyService: ClassifyService) {}

  @Post("/")
  classify(@BodyParams("text") text: string) {
    return this.classifyService.classify(text);
  }
}
