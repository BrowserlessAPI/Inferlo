// The router TanStack Start creates for each request (src/router.tsx in a new TanStack Start project).
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}
