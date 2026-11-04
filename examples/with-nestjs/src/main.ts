import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { AIConfig } from "../../../src/ai/public.ts";
import { toNodeHandler } from "../../../src/index.ts";
import { AppModule } from "./app.module.ts";
import { makeInferlo } from "./inferlo.ts";

export async function bootstrap(config?: AIConfig) {
  const nest = await NestFactory.create(AppModule.register(config), { logger: false });
  // Mount the whole Inferlo app (Express platform). Inferlo reads the body itself, also after Nest's body parser.
  nest.use("/api", toNodeHandler(makeInferlo(config)));
  return nest;
}

