// An existing NestJS app that adopts Inferlo step by step:
// 1. The AI client as an injectable provider, from InferloModule.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) mounted under /api (see main.ts).
import { Module, type DynamicModule } from "@nestjs/common";
import type { AIConfig } from "../../../src/ai/public.ts";
import { InferloModule } from "../../../src/nestjs.ts";
import { makeAI } from "./ai.ts";
import { ClassifyController } from "./classify.controller.ts";
import { ClassifyService } from "./classify.service.ts";

@Module({ controllers: [ClassifyController], providers: [ClassifyService] })
export class ClassifyModule {}

@Module({})
export class AppModule {
  static register(config?: AIConfig): DynamicModule {
    return { module: AppModule, imports: [InferloModule.forRoot({ ai: makeAI(config) }), ClassifyModule] };
  }
}
