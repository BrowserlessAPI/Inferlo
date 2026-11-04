/**
 * Inferlo inside NestJS (11 and later), without a runtime dependency on NestJS:
 *
 *   import { INFERLO_AI, InferloModule } from "@browserlessapi/inferlo/nestjs";
 *
 *   @Module({ imports: [InferloModule.forRoot({ ai })] })   // or forRootAsync({ inject, useFactory })
 *   export class AppModule {}
 *
 *   @Injectable()
 *   export class TicketsService {
 *     constructor(@Inject(INFERLO_AI) private readonly ai: AI) {}
 *   }
 *
 * A whole Inferlo app mounts with app.use("/api", toNodeHandler(inferloApp)) on the Express platform.
 * This entry point never loads the router, database or jobs code.
 */
import type { DynamicModule } from "@nestjs/common";
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";
import { InferloError } from "./errors.ts";

/** Injection token for the AI client: constructor(@Inject(INFERLO_AI) private readonly ai: AI) {}. */
export const INFERLO_AI = "INFERLO_AI";

export interface InferloModuleOptions {
  /** The AI client: createAI(...) from @browserlessapi/inferlo/ai, or an Inferlo app's app.ai. */
  ai: AI;
  /** Make INFERLO_AI injectable in every module without importing InferloModule again. Default true. */
  global?: boolean;
}

export interface InferloModuleAsyncOptions {
  /** Modules whose providers useFactory needs, for example ConfigModule. */
  imports?: DynamicModule["imports"];
  /** Providers passed to useFactory, in order, for example [ConfigService]. */
  inject?: unknown[];
  /** Returns the AI client, for example from configuration: (config) => createAI({ ... }). */
  useFactory: (...args: any[]) => AI | Promise<AI>;
  /** Default true, as in forRoot. */
  global?: boolean;
}

const fix = 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: InferloModule.forRoot({ ai }).';

/** A NestJS module that provides the AI client as INFERLO_AI. Use InferloModule.forRoot({ ai }) in imports. */
export class InferloModule {
  /** Provide an AI client you already have. */
  static forRoot(options: InferloModuleOptions): DynamicModule {
    if (!options || typeof options !== "object") throw new InferloError("IL5016", "InferloModule.forRoot() needs options with ai.", { fix });
    assertAIClient(options.ai, fix);
    return {
      module: InferloModule,
      global: options.global ?? true,
      providers: [{ provide: INFERLO_AI, useValue: options.ai }],
      exports: [INFERLO_AI],
    };
  }

  /** Create the AI client when Nest starts, from other providers (for example ConfigService). */
  static forRootAsync(options: InferloModuleAsyncOptions): DynamicModule {
    if (!options || typeof options.useFactory !== "function") {
      throw new InferloError("IL5016", "InferloModule.forRootAsync() needs a useFactory function.", {
        fix: "Use InferloModule.forRootAsync({ inject: [ConfigService], useFactory: (config) => createAI({ ... }) }).",
      });
    }
    const { useFactory } = options;
    return {
      module: InferloModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: INFERLO_AI,
          inject: (options.inject ?? []) as never[],
          useFactory: async (...args: unknown[]) => {
            const ai = await useFactory(...args);
            assertAIClient(ai, "useFactory must return createAI({ providers, models }) or an Inferlo app's app.ai.");
            return ai;
          },
        },
      ],
      exports: [INFERLO_AI],
    };
  }
}
