// An existing Ts.ED app that adopts Inferlo step by step:
// 1. The AI client as an injectable provider: imports: [inferloAI(ai)] (see main.ts), injected as InferloAI.
// 2. New features as an Inferlo app (auth, validation, rate limits, OpenAPI, MCP) mounted under /api.
import { Configuration, Inject } from "@tsed/di";
import { PlatformApplication } from "@tsed/platform-http";
import type { App } from "../../../src/index.ts";
import { toNodeHandler } from "../../../src/index.ts";
import { ClassifyController } from "./classify.controller.ts";

/** The Inferlo app to mount, set by bootstrap() in main.ts. */
export const INFERLO_APP = Symbol("INFERLO_APP");

@Configuration({
  mount: { "/": [ClassifyController] },
  middlewares: ["json-parser"],
  logger: { level: "off" },
})
export class Server {
  constructor(
    private readonly app: PlatformApplication,
    @Inject(INFERLO_APP) private readonly inferlo: App<any>,
  ) {}

  $beforeRoutesInit() {
    // Mount the whole Inferlo app on the Express app. Express strips "/api", and Inferlo reads the body
    // itself, also after Ts.ED's body parser.
    (this.app.getApp() as { use(path: string, handler: unknown): void }).use("/api", toNodeHandler(this.inferlo));
  }
}
