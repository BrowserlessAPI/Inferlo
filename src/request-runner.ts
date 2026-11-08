/**
 * Runs an app's routes as the caller of a request that reached another server, such as GraphQL Yoga
 * (graphqlContext from @browserlessapi/inferlo/graphql). Kept apart from app.ts so that entry point loads no
 * router code. Internal.
 */
import type { ToolRunner } from "./ai/index.ts";

const runners = new WeakMap<object, (req: Request) => ToolRunner>();

/** Called by createApp with a function that runs a registered route with the credentials of a request. */
export function registerRequestRunner(app: object, runner: (req: Request) => ToolRunner): void {
  runners.set(app, runner);
}

/** The route runner for a request, or undefined for objects that are not apps from createApp. */
export function requestRunner(app: object, req: Request): ToolRunner | undefined {
  return runners.get(app)?.(req);
}
