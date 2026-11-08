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

## Relations

`relations` links model rows to other rows, so a client asks for a note's owner (or a user's notes) in the same query. Each relation field runs a route the app already has, as the caller, and the lookups of one list are batched: a list of 100 notes runs the owner route once with every `ownerId`, never once per note.

```ts
const ids = t.array(t.uuid()).max(100);

// GET /users?ids=...: the users with these ids.
export const usersByIds = route
  .get("/users", { query: t.object({ ids }), response: t.array(User.row) })
  .handle(({ db, query }) => db.users.findMany({ where: { id: { in: query.ids } } }));

// GET /notes/by-owner?ownerIds=...: the notes of these users.
export const notesByOwners = route
  .get("/notes/by-owner", { query: t.object({ ownerIds: ids }), response: t.array(Note.row) })
  .handle(({ db, query, user }) => db.notes.findMany({ where: { ownerId: { in: query.ownerIds } } }));

export const graphql = graphqlRoute({
  query: { notes: listNotes, users: listUsers },
  relations: [
    { model: Note, field: "owner", route: usersByIds, from: "ownerId" },
    { model: User, field: "notes", route: notesByOwners, from: "id", to: "ownerId", arg: "ownerIds", many: true },
  ],
});
```

```graphql
{ notes { title owner { name } } users { name notes { title } } }
```

- **Options.** `model` is the model whose rows get the field and `field` the new field's name. `route` answers the related rows for many values at once, as `t.array(Model.row)` (or another list of objects). `from` is the field of the model's rows whose values are looked up, `arg` (default `"ids"`) the route's array argument (a query or body field) that receives them, and `to` (default `"id"`) the field of the route's rows that matches them. Without `many`, the field is the one matching row or `null` (a belongs-to relation, such as `owner`); with `many: true` it is the list of every matching row, `[]` when none match (a has-many relation, such as a user's `notes`).
- **Where the field appears.** On the object type of the model's full rows: fields of routes with `response: Note.row` or `t.array(Note.row)`, including rows answered by other relations, so relations nest (`users { notes { owner { name } } }`). A relation on rows that no field answers raises IL6059 when the app starts.
- **Same rules as REST.** The relation's route runs as the caller with its auth, permissions, validation, rate limits and tenant scope, so a user only sees the related rows the route lets them see. When it answers an error, every relation field of that batch is `null` with the route's `code` and `status` in its error, and the rest of the answer stays.
- **Batching.** The route runs once per relation and list level: `{ notes { owner { name } reviewer { name } } }` runs the users route twice (owner and reviewer), whatever the number of notes. Values are sent once each, and rows with a `null` value in `from` are `null` (or `[]`) without a lookup.
- **Write the route for batches.** It must answer every row for the values it gets: give it no default `limit`, and give its array argument a `.max()` at least as large as your largest list (the route refuses longer lists with 422, like any validation error).
- **Limits.** Each relation field in a document counts against `maxFields`, separately from the top-level fields, since each runs a route; more answer IL2021.
- `describe()` lists the relations of an endpoint as `graphql.relations: { "notes.owner": "GET /users" }`, and the routes behind them have `graphqlFields: ["notes.owner"]`; OpenAPI has the same lists in `x-inferlo-graphql` and `x-inferlo-graphql-fields`.
- Relations work the same with `graphqlSchema({ query, mutation, relations })` in GraphQL Yoga and Apollo Server.

## Auth and errors

- The endpoint is private by default, like every route: callers send the same `Authorization` header, API key or session cookie as for REST. With `graphqlRoute({ auth: "public", ... })` anonymous callers reach the endpoint, and each field's route still checks its own auth (fields of private routes answer IL3001 to them).
- A route that answers with an error becomes a GraphQL error for that field, with the route's message and, in `extensions`, its `code` (`IL3004`, `IL1001`, ...), HTTP `status` and `details` (validation issues). Server errors only say "Internal error." with their code, as in REST answers. Following GraphQL's rules, a failed field is `null` (or makes its parent `null` when the field is non-null) and the other fields still answer.
- Answers are always `200` with `{ data, errors }` once the request reaches GraphQL; a request without a `query` string is refused with 422 IL1001 before that.

## Limits

- `maxFields` (default 20): the most top-level fields one request may ask for, aliases and fragments included, and separately the most [relation fields](#relations) one document may ask for. Each of them runs a route, so this bounds the work of one request. More answer the errors IL2020 (top-level fields) and IL2021 (relation fields).
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

Its fields run routes only when executed through `graphqlRoute()`, or by another GraphQL server with `graphqlContext()` as the context (next section).

## GraphQL Yoga and other GraphQL servers

Apps that already serve GraphQL with [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) or [Apollo Server](#apollo-server) can serve the same schema there, with the server's plugins, subscriptions and schema explorer. `graphqlContext(app, request)` is the context that lets each field run its route as the caller of the request:

```ts
import { createYoga } from "graphql-yoga";
import { graphqlContext, graphqlSchema } from "@browserlessapi/inferlo/graphql";
import { app } from "./app.ts";
import { createNote, getNote, listNotes } from "./routes/notes.ts";

export const yoga = createYoga({
  schema: graphqlSchema({ query: { notes: listNotes, note: getNote }, mutation: { createNote } }),
  context: ({ request }) => graphqlContext(app, request),
});
```

- **Same rules as REST.** Each field calls its route with the request's `Authorization` header, API key or session cookie, so auth, permissions, validation, rate limits, tenant scope and audit entries are those of the route, and errors are GraphQL errors with the route's `code` and `status` in `extensions`, as with `graphqlRoute()`. The routes must be registered with the app (`createApp({ routes })`); a field whose route is not answers "Internal error." with IL5011.
- **The request** is a Web `Request` (Yoga's `request`) or a Node.js request (Yoga's `req` when it runs in `node:http`, or what other Node.js servers pass to their context function). With a Node.js request, per-IP rate limits of the field routes use its socket address; with a Web `Request` from a server that does not record it, every client counts as one address unless `createApp({ trustProxy: true })` reads `X-Forwarded-For`.
- **Your own context fields** sit next to it: `context: ({ request }) => ({ ...graphqlContext(app, request), requestedAt: Date.now() })`.
- **Limits** of `graphqlRoute()` (`maxFields`, the document size, `introspection: false`) belong to that endpoint; with Yoga, use Yoga's own options and plugins for them. The routes' own rate limits apply either way.
- Without `graphqlContext`, fields answer IL6059. Arguments that are not an app from `createApp()` and a request raise IL6060.

Tested with GraphQL Yoga 5 (newest 5.x, with `graphql` 16) and the latest release (6), on Node.js, Bun and Deno.

### Apollo Server

Apollo Server 5 passes the Node.js request to its context function as `req`, both in its standalone server and in its Express middleware:

```ts
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { graphqlContext, graphqlSchema, type GraphQLContext } from "@browserlessapi/inferlo/graphql";
import { app } from "./app.ts";
import { createNote, getNote, listNotes } from "./routes/notes.ts";

const server = new ApolloServer<GraphQLContext>({
  schema: graphqlSchema({ query: { notes: listNotes, note: getNote }, mutation: { createNote } }),
});

const { url } = await startStandaloneServer(server, {
  listen: { port: 4000 },
  context: async ({ req }) => graphqlContext(app, req),
});
```

In an Express app, with `expressMiddleware` from `@as-integrations/express5` (Express 5) or `@as-integrations/express4` (Express 4):

```ts
await server.start();
web.use("/graphql", express.json(), expressMiddleware(server, { context: async ({ req }) => graphqlContext(app, req) }));
```

- Fields behave as with Yoga: each runs its route as the caller of `req` (its `Authorization` header, API key or session cookie), with the route's auth, permissions, validation, rate limits, tenant scope and audit; per-IP rate limits use the socket address of `req`. Errors keep the route's `code` and `status` in `extensions`.
- `server.executeOperation(request, { contextValue: graphqlContext(app, webRequest) })` runs an operation in tests as the caller of a Web `Request`.
- Apollo Server 5 needs `graphql` 16 (`npm install @apollo/server graphql@16`); Inferlo's GraphQL module works with both 16 and 17.

Tested with Apollo Server 5.0.0 and the latest release, both with `graphql` 16, standalone and with `@as-integrations/express5`, on Node.js and Bun.

Each field is one in-process call of its route; nested data comes from the route's answer, so a field never runs extra queries per item. Tested with `graphql` 16 (newest 16.x) and the latest release (17), on Node.js, Bun and Deno.
