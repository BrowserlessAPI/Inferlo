# Migrate from Fastify

This guide moves an existing Fastify app (Fastify 5) to Inferlo one route at a time. The app keeps running in the same Node.js process and keeps its URLs during the whole migration: Inferlo answers the routes you have moved, Fastify answers the rest. Nothing has to be rewritten in one go.

What you gain on every route you move: validation and types from one schema instead of JSON schemas plus separate TypeScript types, routes private by default, the same error format everywhere (`ILxxxx` codes), a database layer with migrations, rate limits, background jobs, an OpenAPI document and an MCP server generated from the routes, and AI models through `ctx.ai`. See [comparison](comparison.md) for the bigger picture.

## 1. Add Inferlo next to Fastify

```bash
npm install @browserlessapi/inferlo
```

Create an empty Inferlo app beside your Fastify code, for example in `src/inferlo/app.ts`:

```ts
// src/inferlo/app.ts
import { createApp } from "@browserlessapi/inferlo";
import { auth } from "./auth.ts";
import * as tickets from "./routes/tickets.ts";

export const app = createApp({
  name: "helpdesk",
  routes: [tickets],
  auth,
  logging: { requests: true },
});
```

Register it with `inferloPlugin` from `@browserlessapi/inferlo/fastify` and `fallthrough: true`:

```ts
// src/server.ts (your existing Fastify entry point)
import Fastify from "fastify";
import { inferloPlugin } from "@browserlessapi/inferlo/fastify";
import { app as inferlo } from "./inferlo/app.ts";

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: ["https://app.example.com"] });
fastify.get("/users/:id", { preHandler: requireUser }, getUser);   // not moved yet: Fastify answers

await fastify.register(inferloPlugin, { app: inferlo, fallthrough: true }); // Inferlo's routes, OpenAPI and MCP

await fastify.listen({ port: 3000 });
```

With `fallthrough: true`, Inferlo answers only the requests it has a route for (method and path) and its own endpoints (`/openapi.json`, `/mcp`, health, metrics and CORS preflights of its paths), in an `onRequest` hook, before Fastify reads the body. Every other request goes on to Fastify's router as before, including other methods on the same path and Fastify's own 404 handler. As you move routes, more requests stop at Inferlo; nothing else changes.

- Order: where you register the plugin does not change which requests Inferlo answers. `onRequest` hooks added before it on the root instance (request ids, logging) also run for Inferlo's requests; hooks added after it, hooks inside encapsulated plugins and the later hooks (`preParsing`, `preValidation`, `preHandler`, `onSend`) do not, because Inferlo answers the request itself.
- Body parsing: Inferlo reads the request body itself (JSON, forms, its own `maxBodySize`), so Fastify's content type parsers and `bodyLimit` stay as they are for your Fastify routes.
- Global plugins that change responses (`@fastify/cors`, `@fastify/helmet`, `@fastify/compress`) work through `onSend` and similar hooks, so they do not apply to Inferlo's responses. Inferlo sends its own CORS and security headers; configure them in `createApp`.
- To keep the new routes under their own path for a while, add a prefix: `{ app: inferlo, prefix: "/v2", fallthrough: true }` answers the app's routes under `/v2` only. Without `fallthrough`, `{ app, prefix: "/v2" }` gives the whole prefix to Inferlo, including its 404s. To use only Inferlo's AI features in Fastify routes, see [`fastify.ai` and `request.ai`](integrations.md#fastify-1).

## 2. Move one route

Before, in Fastify with a JSON schema, a TypeScript type for the same body and an auth hook:

```ts
interface CreateTicket { title: string; priority?: "low" | "normal" | "urgent" }

fastify.post<{ Body: CreateTicket }>(
  "/tickets",
  {
    preHandler: requireUser,
    schema: {
      body: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", minLength: 3, maxLength: 200 },
          priority: { type: "string", enum: ["low", "normal", "urgent"], default: "normal" },
        },
      },
    },
  },
  async (request, reply) => {
    const ticket = await tickets.insert({ ...request.body, ownerId: request.user.id });
    return reply.code(201).send(ticket);
  },
);
```

After, in Inferlo:

```ts
// src/inferlo/routes/tickets.ts
import { route, t } from "@browserlessapi/inferlo";
import { tickets } from "../../db.ts"; // your existing data access code

export const createTicket = route
  .post("/tickets", {
    body: t.object({
      title: t.string().min(3).max(200),
      priority: t.enum(["low", "normal", "urgent"]).default("normal"),
    }),
    summary: "Create a ticket",
  })
  .handle(async ({ body, user, status }) => {
    status(201);
    return tickets.insert({ ...body, ownerId: user.id });
  });
```

Then delete the Fastify route. Requests to `POST /tickets` now stop at Inferlo, at the same URL.

- One `t.*` schema replaces the JSON schema and the TypeScript type (or a TypeBox or Zod type provider): invalid input gets `422` with IL1001 and every problem listed, and `body` is typed. `query` and `params` schemas replace `schema.querystring` and `schema.params` and convert strings to numbers and booleans the same way. `response` replaces `schema.response` for the OpenAPI document.
- The route is private by default: `user` is the signed-in user (no more `request.user` from a decorator), and requests without one get `401` (IL3001). This replaces `preHandler: requireUser`, `@fastify/jwt` with `request.jwtVerify()` and `@fastify/auth`. Add `auth: "public"` to routes anyone may call, or a role name such as `auth: "admin"`.
- Return the value; call `status(201)` instead of `reply.code(201)` and `header(name, value)` instead of `reply.header(...)`. `undefined` sends `204`. Return a `Response` for anything that is not JSON.
- Throw `notFound()`, `forbidden()` or `httpError(409, "...")` instead of `reply.code(404).send(...)` or `@fastify/sensible`'s `reply.notFound()` and `fastify.httpErrors`.
- The error format changes from Fastify's `{ statusCode, error, message }` to Inferlo's `{ "error": { "code", "message", ... } }`. If clients parse error bodies, tell them, or move routes in groups that one client uses.

## 3. Map Fastify concepts to Inferlo

| Fastify | Inferlo |
|---|---|
| `fastify.get(path, options, handler)`, route shorthand and `fastify.route({ ... })` | `export const x = route.get(path, options).handle(handler)` in a routes file, registered with `createApp({ routes: [file] })` |
| `schema: { body, querystring, params }` (Ajv JSON schemas), type providers | `body`, `query` and `params` with `t.*` schemas: validation and types from one definition ([schemas](schema.md)) |
| `schema.response` and fast-json-stringify | `response: schema` on the route, used for OpenAPI |
| `request.body`, `request.query`, `request.params` | `body`, `query`, `params` in the handler context |
| `return value`, `reply.code(201)`, `reply.header()` | `return value`, `status(201)`, `header(name, value)` |
| Plugins with `fastify.register(plugin, { prefix })` and encapsulation | Route files grouped into [modules](modules.md) with explicit `imports`; `apiVersion("v1", routes)` for `/v1` ([API versions](routes.md#api-versions)) |
| `fastify-plugin` to share decorators | Not needed: modules export plain functions in `provides`, called directly |
| `fastify.decorate("db", ...)`, `decorateRequest` | Import the value, or use `ctx.db`, `ctx.ai`, `ctx.jobs` and `state` from middleware |
| Hooks: `onRequest`, `preHandler` for auth and checks | The route's `auth`, `permission` and `rateLimit` options; `createApp({ middleware })` for cross-cutting code |
| Hooks: `onSend`, `onResponse`, `onError` | `createApp({ middleware })` (it sees the response), request logs with timing, and logged errors |
| `fastify.setErrorHandler`, `setNotFoundHandler` | Built in: every error becomes the standard error body; unexpected errors are logged with secrets redacted |
| `@fastify/jwt`, `@fastify/auth`, `@fastify/basic-auth` | `createApp({ auth })` with `bearer(...)` or `auth: { resolve(req) { ... } }` ([auth](auth.md)) |
| `@fastify/cors` | `createApp({ cors: { origin: [...] } })` |
| `@fastify/helmet` | Built in: security headers on every response ([security](security.md)) |
| `@fastify/rate-limit` | The route's `rateLimit: { max, per, by }`, with memory or Postgres stores ([routes](routes.md)) |
| `@fastify/formbody`, `bodyLimit` | Built in for JSON and forms, with `createApp({ maxBodySize })` |
| `@fastify/env`, `env-schema` | `config({ schema })` in `src/config.ts` ([configuration](config.md)) |
| `@fastify/swagger`, `@fastify/swagger-ui` | Generated: `GET /openapi.json` from the route schemas |
| `@fastify/under-pressure`, health check plugins | `createApp({ health: true })` with `/health` and `/ready` ([observability](observability.md)) |
| `fastify-metrics` | `createApp({ metrics })` with `/metrics` in the Prometheus format |
| Pino logger, `request.log`, `genReqId` | `createApp({ logging: { format: "json", requests: true } })` and `X-Request-Id` ([observability](observability.md)) |
| `@fastify/schedule`, queue plugins | `job(...)`, `cron(...)` and `inferlo worker` ([jobs](jobs.md)) |
| `reply.sse(...)`, streaming replies | `return ctx.ai.stream(...).toResponse()` for model output, or a `Response` with a `ReadableStream` |
| `fastify.inject()` in tests | `app.request(path, { method, json, as: user })` with a signed-in test user ([testing](testing.md)) |
| `fastify.listen()` and `fastify.close()` | `app.listen(3000)` and `app.close()` on SIGTERM ([deployment](deploy.md)) |

`@fastify/static`, `@fastify/view`, `@fastify/multipart`, `@fastify/websocket` and `@fastify/session` have no Inferlo equivalent yet: keep those routes in Fastify (they keep working next to Inferlo), or serve static files from a CDN or reverse proxy.

## 4. Share auth between both

During the migration, Fastify and Inferlo routes must accept the same credentials. Put the check in one function and use it from both:

```ts
// src/auth-check.ts
export async function userFromToken(token: string | undefined) {
  if (!token) return null;
  const session = await sessions.findByToken(token); // your existing lookup
  return session ? { id: session.userId, roles: session.roles } : null;
}
```

```ts
// Fastify preHandler hook, as before
export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await userFromToken(request.headers.authorization?.replace(/^Bearer /, ""));
  if (!user) return reply.code(401).send({ message: "Sign in required" });
  request.user = user;
}
```

```ts
// src/inferlo/auth.ts
import { bearer } from "@browserlessapi/inferlo";
import { userFromToken } from "../auth-check.ts";

export const auth = bearer((token) => userFromToken(token));
```

A user needs an `id`, and `roles` for role-based routes. For cookie sessions or other schemes, write `auth: { resolve(req) { ... } }`; `req` is a standard `Request` with the same headers and cookies Fastify sees.

## 5. Keep your data layer, then adopt models where they fit

Inferlo handlers can call any database code you already have (`@fastify/postgres`'s pool, Knex, Prisma, Drizzle, TypeORM, MikroORM): import it and use it in the handler. Values that only exist as Fastify decorators (`fastify.pg`) need to be created in a module both sides import, for example a shared `pg` pool. You do not have to move data access to switch routes.

For new tables, use Inferlo [models](database.md): validated inserts and updates, typed queries, relations, pagination and generated migrations (`inferlo db migrate`). Inferlo models expect a `uuid` `id`, `created_at` and `updated_at` columns and snake_case column names, so existing tables that differ are best left with your current code.

## 6. Move the tests

```ts
// Before: fastify.inject with a token
const res = await fastify.inject({ method: "POST", url: "/tickets", headers: { authorization: `Bearer ${token}` }, payload: { title: "Printer" } });

// After: signed in as a test user, without a server
import { readJson } from "@browserlessapi/inferlo/testing";

const res = await app.request("/tickets", { method: "POST", json: { title: "Printer" }, as: { id: "u1", roles: [] } });
const ticket = await readJson(res, 201);
```

`fastify.inject()` tests keep working during the migration, because moved routes are answered at the same URLs.

## 7. Remove Fastify

When the last Fastify route is gone, start the Inferlo app directly:

```ts
// src/server.ts
import { app } from "./inferlo/app.ts";

const server = await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Listening on http://localhost:${server.port}`);
process.on("SIGTERM", () => void app.close({ delayMs: 5000 }));
```

Then remove `fastify` and the plugins Inferlo replaced. Compare your app with a new project from `npx @browserlessapi/inferlo new` for the recommended layout, configuration and AGENTS.md for AI coding tools.

## Checklist

- [ ] `fastify.register(inferloPlugin, { app: inferlo, fallthrough: true })`
- [ ] One auth check shared by Fastify and Inferlo
- [ ] Each moved route: schemas for its input, the right `auth`, `status(201)` where clients expect it, the Fastify route deleted, a test with `app.request`
- [ ] CORS and security headers configured in `createApp` for Inferlo's routes (Fastify's `onSend` plugins do not touch them)
- [ ] Clients told about the new error format, if they read error bodies
- [ ] Fastify removed, `app.listen()` and `app.close()` on SIGTERM

If you only want Inferlo's AI features inside Fastify and no migration, use `fastify.ai` and `request.ai` from [`@browserlessapi/inferlo/fastify`](integrations.md#fastify-1) instead.
