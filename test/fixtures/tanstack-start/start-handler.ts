/**
 * TanStack Start's own request handler (createStartHandler from @tanstack/react-start/server), the one a built app
 * runs, with its router entry pointed at routerEntry (a module URL that exports getRouter). Needs Node.js module hooks.
 */
import { register } from "node:module";

export async function startHandler(routerEntry: string): Promise<(request: Request) => Promise<Response>> {
  process.env.TSS_SERVER_FN_BASE ??= "/_serverFn/";
  register(new URL("./hooks.ts", import.meta.url), { data: { routerEntry } });
  const { createStartHandler, defaultStreamHandler } = await import("@tanstack/react-start/server");
  const handler = createStartHandler(defaultStreamHandler) as unknown as (request: Request) => Promise<Response>;
  return (request) => handler(request);
}
