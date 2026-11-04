import { Body, Controller, Post } from "@nestjs/common";
import { ClassifyService } from "./classify.service.ts";

@Controller("classify")
export class ClassifyController {
  constructor(private readonly classifyService: ClassifyService) {}

  @Post()
  classify(@Body() body: { text: string }) {
    return this.classifyService.classify(body.text);
  }
}
