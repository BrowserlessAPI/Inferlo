/**
 * API versions: apiVersion("v1", routes) puts routes under /v1, marks them as version v1 and gives the
 * version its own OpenAPI document at /v1/openapi.json.
 *
 *   createApp({
 *     routes: [
 *       apiVersion("v1", [ticketsV1], { deprecated: { since: "2026-11-01", sunset: "2027-06-30" } }),
 *       apiVersion("v2", [tickets]),
 *       [auth],                          // routes outside every version: in each version's document
 *     ],
 *   })
 *
 * The same route can be in several versions (an endpoint that did not change): each version gets its own
 * copy under its prefix. Routes are named <version>_<export name> (v1_listTickets), so OpenAPI operation
 * ids and MCP tool names stay unique across versions.
 */
import type { RouteSource } from "./app.ts";
import type { Deprecation } from "./deprecation.ts";
import { InferloError } from "./errors.ts";
import { collectRoutes, type RouteDef } from "./route.ts";

const VERSION = /^v[1-9][0-9]{0,5}$/;

export interface ApiVersionOptions {
  /**
   * Deprecate every route of the version: true, or { since, sunset, link } to send the Deprecation, Sunset
   * and Link headers on each of its responses. A route's own deprecated option wins.
   */
  deprecated?: boolean | Deprecation;
}

function invalid(message: string, fix: string): InferloError {
  return new InferloError("IL6025", message, { fix });
}

/** Put routes under /<version> as API version <version> ("v1", "v2"), with an OpenAPI document of their own. */
export function apiVersion(version: string, routes: readonly RouteSource[], options: ApiVersionOptions = {}): RouteDef[] {
  if (typeof version !== "string" || !VERSION.test(version)) {
    throw invalid(`API version ${JSON.stringify(version)} is not valid.`, 'Use "v" and a number: apiVersion("v1", [...]), apiVersion("v2", [...]).');
  }
  if (!Array.isArray(routes)) throw invalid(`apiVersion("${version}") routes must be an array.`, `Use apiVersion("${version}", [tickets]) with route files (import * as tickets) or routes.`);
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw invalid(`apiVersion("${version}") options must be an object.`, `Use apiVersion("${version}", routes, { deprecated: { since, sunset, link } }).`);
  for (const key of Object.keys(options)) {
    if (key !== "deprecated") throw invalid(`apiVersion("${version}") has an unknown option "${key}".`, "The only option is deprecated.");
  }
  const defs = collectRoutes(routes);
  if (defs.length === 0) throw invalid(`apiVersion("${version}") has no routes.`, `Pass route files or routes: apiVersion("${version}", [tickets]).`);
  return defs.map((r) => {
    if (r.version !== undefined) {
      throw invalid(`The route ${r.method} ${r.path} is already in API version ${r.version}, so it cannot be put in ${version} as well.`, "Put the original route (not the result of apiVersion) in each version that should have it.");
    }
    const deprecated = r.options.deprecated ?? options.deprecated;
    return Object.freeze({
      ...r,
      path: `/${version}${r.path === "/" ? "" : r.path}`,
      version,
      ...(r.name ? { name: `${version}_${r.name}` } : {}),
      options: deprecated === undefined ? r.options : { ...r.options, deprecated },
    });
  });
}

/** The API versions of these routes, in order of their numbers. */
export function versionsOf(routes: readonly RouteDef[]): string[] {
  return [...new Set(routes.map((r) => r.version).filter((v): v is string => v !== undefined))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** Path of a version's OpenAPI document: /v1/openapi.json for openapi path /openapi.json. */
export function versionDocPath(version: string, openapiPath: string): string {
  return `/${version}${openapiPath}`;
}
