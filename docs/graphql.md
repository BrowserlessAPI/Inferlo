# GraphQL

`graphqlRoute()` from `@browserlessapi/inferlo/graphql` adds a GraphQL endpoint whose queries and mutations are routes the app already has. There is no second set of resolvers: each field runs its route, so GraphQL clients get the same auth, permissions, validation, rate limits, tenant scope, caching and audit entries as REST clients, and a rule added to a route applies to both.

```ts
// src/routes/graphql.ts
import { graphqlRoute } from "@browserlessapi/inferlo/graphql";
import { createNote, deleteNote, getNote, listNotes } from "./notes.ts";

export const graphql = graphqlRoute({
  query: { notes: listNotes, note: getNote },
  mutation: { createNote, deleteNote },
});

// src/app.ts
import * as graphql from "./routes/graphql.ts";
export const app = createApp({ models, routes: [notes, graphql], auth });
```

Install `graphql` (version 16 or 17) in the app; it is an optional peer dependency that the core package never loads.

```bash
curl -X POST localhost:3000/graphql -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"query":"mutation { createNote(title: \"Hello\") { id title } }"}'
```

## Fields

- **Names.** The keys of `query` and `mutation` are the field names. Map GET routes to `query` and routes that change data to `mutation`; GraphQL clients run mutations one after another, queries in parallel.
- **Arguments** are the route's path params, query and body fields, with the same names (`note(id: String!)`, `notes(limit: Int)`, `createNote(title: String!, priority: CreateNotePriority)`). Required fields without a default are non-null. Nested objects become input types.
- **Types** come from the route's `response` schema: `t.string()`, `t.uuid()`, `t.email()` and `t.date()` are `String` (dates as ISO 8601 text), `t.int()` is `Int`, `t.number()` is `Float`, `t.boolean()` is `Boolean`, `t.enum([...])` is an enum when its values are valid GraphQL names, `t.array(...)` is a list, `t.object({ ... })` and model rows (`notes.row`) are object types (identical shapes share one type), and `.nullable()` or `.optional()` fields can be null. A route without a `response` schema, and `t.json()` or `t.any()` fields, return the `JSON` scalar. Give routes a `response` so clients can select fields.
- **Descriptions** come from the route's `description` or `summary`, and deprecated routes are deprecated fields.

GraphQL's `Int` is a 32-bit number; use `t.number()` (or a string) in the response for larger whole numbers.

## Auth and errors

- The endpoint is private by default, like every route: callers send the same `Authorization` header, API key or session cookie as for REST. With `graphqlRoute({ auth: "public", ... })` anonymous callers reach the endpoint, and each field's route still checks its own auth (fields of private routes answer IL3001 to them).
- A route that answers with an error becomes a GraphQL error for that field, with the route's message and, in `extensions`, its `code` (`IL3004`, `IL1001`, ...), HTTP `status` and `details` (validation issues). Server errors only say "Internal error." with their code, as in REST answers. Following GraphQL's rules, a failed field is `null` (or makes its parent `null` when the field is non-null) and the other fields still answer.
- Answers are always `200` with `{ data, errors }` once the request reaches GraphQL; a request without a `query` string is refused with 422 IL1001 before that.

## Limits

- `maxFields` (default 20): the most top-level fields one request may ask for, aliases and fragments included. Each top-level field runs a route, so this bounds the work of one request. More answer the error IL2020.
- Documents are at most 100,000 characters and 10,000 tokens. Field selections cannot nest deeper than the response schemas, which have no cycles.
- `rateLimit: { max, per, by }` limits requests to the endpoint, on top of each route's own `rateLimit`.
- `introspection: false` refuses `__schema` and `__type` queries, for production APIs that should not publish their schema.
- `path` (default `"/graphql"`) and `auth` (default `"user"`) are the endpoint's path and auth.

Invalid options and routes that cannot be fields raise IL6059 when the app starts. Fields must map to routes registered with the same app: a field whose route is not in `createApp({ routes })` answers "Internal error." with IL5011. Routes that take files (`t.file()`) cannot be fields.

## In describe and OpenAPI

`app.describe()` and `inferlo describe` show which routes the GraphQL API runs, so coding agents and reviewers see a route's GraphQL callers before they change it:

- The endpoint's entry has `graphql: { query: { notes: "GET /notes", note: "GET /notes/:id" }, mutation: { createNote: "POST /notes" } }`, each field with the route it runs (under `apiVersion()`, the versioned path).
- Each route that is a field has `graphqlFields: ["Query.notes"]` (one entry per field and endpoint that runs it). `inferlo describe` prints `graphql=7 fields` next to the endpoint and `graphql=Query.notes` next to its routes.
- OpenAPI has the same lists as the extensions `x-inferlo-graphql` (on the endpoint's `POST` operation) and `x-inferlo-graphql-fields` (on each field's operation).

## Schema for clients

`graphqlSchema({ query, mutation })` returns the same schema as a `GraphQLSchema`, for client code generation and schema checks in CI:

```ts
import { printSchema } from "graphql";
import { graphqlSchema } from "@browserlessapi/inferlo/graphql";

console.log(printSchema(graphqlSchema({ query: { notes: listNotes, note: getNote }, mutation: { createNote } })));
```

Its fields run routes only when executed through `graphqlRoute()`.

Each field is one in-process call of its route; nested data comes from the route's answer, so a field never runs extra queries per item. Tested with `graphql` 16 (newest 16.x) and the latest release (17), on Node.js, Bun and Deno.
