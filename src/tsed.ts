/**
 * Inferlo inside Ts.ED (8 and later), without a runtime dependency on Ts.ED:
 *
 *   import { InferloAI, inferloAI } from "@browserlessapi/inferlo/tsed";
 *
 *   @Configuration({ imports: [inferloAI(ai)] })   // or { token: InferloAI, useFactory: () => createAI(...) }
 *   export class Server {}
 *
 *   @Injectable()
 *   export class TicketsService {
 *     constructor(private readonly ai: InferloAI) {}   // or: ai = inject(InferloAI)
 *   }
 *
 * A whole Inferlo app mounts with app.use("/api", toNodeHandler(inferloApp)) in $beforeRoutesInit on the
 * Express platform. This entry point never loads the router, database or jobs code.
 */
import type { AI } from "./ai/index.ts";
import { assertAIClient } from "./ai-client.ts";

/**
 * Injection token and type of the AI client in Ts.ED: constructor(private readonly ai: InferloAI) {},
 * @Inject(InferloAI) ai: InferloAI, or inject(InferloAI). It has every method of AI.
 */
export abstract class InferloAI {}
export interface InferloAI extends AI {}

/** A Ts.ED provider that registers an AI client as InferloAI, for @Configuration({ imports }) and PlatformTest.create({ imports }). */
export interface InferloAIProvider {
  token: typeof InferloAI;
  use: AI;
}

/** Registers an AI client (createAI(...) or an Inferlo app's app.ai) for injection: @Configuration({ imports: [inferloAI(ai)] }). */
export function inferloAI(ai: AI): InferloAIProvider {
  assertAIClient(ai, 'Pass createAI({ providers, models }) from "@browserlessapi/inferlo/ai", or an Inferlo app\'s app.ai: @Configuration({ imports: [inferloAI(ai)] }).');
  return { token: InferloAI, use: ai };
}
