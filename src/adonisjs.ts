/**
 * Inferlo inside AdonisJS (6 and 7). A provider that binds the AI client in the container as "ai" and adds
 * ctx.ai to every HTTP context:
 *
 *   // config/ai.ts
 *   import env from "#start/env";
 *   import { anthropic, createAI } from "@browserlessapi/inferlo/ai";
 *
 *   export default createAI({
 *     providers: { anthropic: anthropic({ apiKey: env.get("ANTHROPIC_API_KEY") }) },
 *     models: { fast: "anthropic:claude-haiku-4-5" },
 *   });
 *
 *   // adonisrc.ts
 *   providers: [..., () => import("@browserlessapi/inferlo/adonisjs")],
 *
 *   // start/routes.ts
 *   router.post("/classify", async ({ ai, request }) => (await ai.generate({ model: "fast", prompt: request.input("text") })).text);
 *
 * Anywhere else: const ai = await app.container.make("ai"). Nothing from AdonisJS is loaded until the provider boots,
 * and this entry point never loads Inferlo's router, database or jobs code.
 */
import type {} from "@adonisjs/core/http";
import type {} from "@adonisjs/core/types";
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";
import { InferloError } from "./errors.ts";

declare module "@adonisjs/core/types" {
  interface ContainerBindings {
    /** The AI client from config/ai.ts, bound by the Inferlo provider. */
    ai: AI;
  }
}

declare module "@adonisjs/core/http" {
  interface HttpContext {
    /** The AI client from config/ai.ts, added by the Inferlo provider. */
    ai: AI;
  }
}

/** The parts of AdonisJS's ApplicationService that the provider uses. */
export interface AdonisApplicationLike {
  config: { get(key: string, defaultValue?: unknown): unknown };
  container: {
    singleton(binding: "ai", resolver: () => AI | Promise<AI>): void;
    make(binding: "ai"): Promise<AI>;
  };
}

const FIX = 'Create config/ai.ts with export default createAI({ providers, models }) from "@browserlessapi/inferlo/ai" (or an Inferlo app\'s app.ai).';

/**
 * The AdonisJS provider: providers: [() => import("@browserlessapi/inferlo/adonisjs")] in adonisrc.ts.
 * Reads the AI client from config/ai.ts, binds it in the container as "ai", and adds ctx.ai to HTTP contexts.
 */
export default class InferloProvider {
  protected app: AdonisApplicationLike;

  constructor(app: AdonisApplicationLike) {
    this.app = app;
  }

  register(): void {
    this.app.container.singleton("ai", () => {
      const ai = this.app.config.get("ai");
      if (ai === undefined) {
        throw new InferloError("IL5018", "The Inferlo AdonisJS provider found no config/ai.ts.", { fix: FIX });
      }
      assertAIClient(ai, FIX);
      return ai;
    });
  }

  async boot(): Promise<void> {
    // Fails at startup, not on the first request, when config/ai.ts is missing or wrong.
    const ai = await this.app.container.make("ai");
    const { HttpContext } = await import("@adonisjs/core/http");
    HttpContext.getter("ai", () => ai);
  }
}

