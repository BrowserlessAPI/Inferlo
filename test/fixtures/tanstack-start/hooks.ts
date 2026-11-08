/**
 * Module hooks for the TanStack Start tests: TanStack Start's request handler imports its router and start entries and
 * its manifest from modules its Vite plugin provides. These hooks point them at the router entry given to register()
 * as data.routerEntry (a module exporting getRouter, like src/router.tsx) and at the files next to this one, so tests
 * run TanStack Start's own server route dispatch without a Vite build.
 */
const entries: Record<string, string> = {
  "#tanstack-start-entry": new URL("./start-entry.ts", import.meta.url).href,
  "tanstack-start-manifest:v": new URL("./manifest.ts", import.meta.url).href,
};

export async function initialize(data: { routerEntry: string }): Promise<void> {
  entries["#tanstack-router-entry"] = data.routerEntry;
}

export async function resolve(specifier: string, context: unknown, next: (specifier: string, context: unknown) => Promise<unknown>): Promise<unknown> {
  const url = entries[specifier];
  if (url) return { url, shortCircuit: true };
  return next(specifier, context);
}
