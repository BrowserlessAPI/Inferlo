/** The router entry TanStack Start's handler loads: the test sets the route tree before the first request. */
import { createRouter, type AnyRoute } from "@tanstack/react-router";

let routeTree: AnyRoute | undefined;

export function setRouteTree(tree: AnyRoute): void {
  routeTree = tree;
}

export function getRouter() {
  if (!routeTree) throw new Error("Call setRouteTree() before the first request.");
  return createRouter({ routeTree });
}
