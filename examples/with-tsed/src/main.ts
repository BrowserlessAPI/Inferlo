import "reflect-metadata";
import { PlatformExpress } from "@tsed/platform-express";
import type { AIConfig } from "../../../src/ai/public.ts";
import { inferloAI } from "../../../src/tsed.ts";
import { makeAI } from "./ai.ts";
import { makeInferlo } from "./inferlo.ts";
import { INFERLO_APP, Server } from "./server.ts";

export async function bootstrap(config?: AIConfig, port: number | string = 0) {
  return PlatformExpress.bootstrap(Server, {
    httpPort: port,
    httpsPort: false,
    imports: [inferloAI(makeAI(config)), { token: INFERLO_APP, use: makeInferlo(config) }],
  });
}
