/**
 * Which routes are GraphQL endpoints (graphqlRoute from @browserlessapi/inferlo/graphql) and which routes are their
 * fields, for describe() and OpenAPI. Internal: it never loads graphql.
 */
import type { RouteDef } from "./route.ts";

export interface GraphQLEndpointFields {
  query: Record<string, RouteDef>;
  mutation: Record<string, RouteDef>;
  /** Relation fields ("notes.owner": model and field) and the routes they run. */
  relations?: Record<string, RouteDef>;
}

/**
 * The fields of each GraphQL endpoint, keyed by the endpoint's handler: apiVersion() copies route definitions but keeps
 * their handlers, so a versioned endpoint is found too.
 */
export const graphqlEndpoints = new WeakMap<RouteDef["handler"], GraphQLEndpointFields>();

/** Field to "METHOD /path" of its route, per operation type, as describe() and OpenAPI list them. */
export interface GraphQLFieldsDescription {
  query: Record<string, string>;
  mutation: Record<string, string>;
  /** Relation fields ("notes.owner") to "METHOD /path" of their route; only for endpoints with relations. */
  relations?: Record<string, string>;
}

/** The GraphQL endpoints among routes, with their fields, and the fields ("Query.notes") each route serves. */
export function graphqlInfo(routes: readonly RouteDef[]): { endpoint(route: RouteDef): GraphQLFieldsDescription | undefined; fields(route: RouteDef): string[] | undefined } {
  const endpoints = new Map<RouteDef, GraphQLFieldsDescription>();
  const fieldsOf = new Map<RouteDef["handler"], string[]>();
  for (const endpoint of routes) {
    const info = graphqlEndpoints.get(endpoint.handler);
    if (!info) continue;
    // A field runs the route the app registered with the same handler (its versioned path, if any).
    const label = (r: RouteDef) => {
      const registered = routes.find((x) => x.handler === r.handler && x.version === endpoint.version) ?? routes.find((x) => x.handler === r.handler) ?? r;
      return `${registered.method} ${registered.path}`;
    };
    const list = (kind: "Query" | "Mutation" | "", fields: Record<string, RouteDef>) =>
      Object.fromEntries(
        Object.entries(fields).map(([name, r]) => {
          const names = fieldsOf.get(r.handler) ?? [];
          const field = kind ? `${kind}.${name}` : name;
          if (!names.includes(field)) names.push(field);
          fieldsOf.set(r.handler, names);
          return [name, label(r)];
        }),
      );
    endpoints.set(endpoint, { query: list("Query", info.query), mutation: list("Mutation", info.mutation), ...(info.relations ? { relations: list("", info.relations) } : {}) });
  }
  return {
    endpoint: (route) => endpoints.get(route),
    fields: (route) => fieldsOf.get(route.handler),
  };
}
