# Migrate from Koa

This guide moves an existing Koa app (Koa 2 or 3) to Inferlo one route at a time. The app keeps running in the same Node.js process and keeps its URLs during the whole migration: Inferlo answers the routes you have moved, Koa answers the rest. Nothing has to be rewritten in one go.

What you gain on every route you move: validation and types from one schema instead of hand-written checks, routes private by default, the same error format everywhere (`ILxxxx` codes), a database layer with migrations, rate limits, background jobs, an OpenAPI document and an MCP server generated from the routes, and AI models through `ctx.ai`. See [comparison](comparison.md) for the bigger picture.

## 1. Add Inferlo next to Koa

```bash
npm install @browserlessapi/inferlo
```

Create an empty Inferlo app beside your Koa code, for example in `src/inferlo/app.ts`:

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

Mount it with `toKoaMiddleware(app, { fallthrough: true })` from `@browserlessapi/inferlo/koa`, **before** your Koa router:

```ts
// src/server.ts (your existing Koa entry point)
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "@koa/bodyparser";
import { toKoaMiddleware } from "@browserlessapi/inferlo/koa";
import { app as inferlo } from "./inferlo/app.ts";

const koa = new Koa();
const router = new Router();

router.get("/users/:id", requireUser, getUser);   // not moved yet: Koa answers

koa.use(bodyParser());
koa.use(toKoaMiddleware(inferlo, { fallthrough: true })); // Inferlo's routes, OpenAPI and MCP; everything else goes on
koa.use(router.routes()).use(router.allowedMethods());

koa.listen(3000);
```

With `fallthrough: true`, Inferlo answers only the requests it has a route for (method and path) and its own endpoints (`/openapi.json`, `/mcp`, health, metrics and CORS preflights of its paths), and calls `next()` for everything else, so Koa's router keeps answering what it had, including other methods on the same path. As you move routes, more requests stop at Inferlo; nothing else changes.

- Body parsers: when `@koa/bodyparser` or `koa-bodyparser` runs first, Inferlo uses `ctx.request.body`; when Inferlo comes first, it reads the request itself. Either order works.
- Middleware added before Inferlo (logging, request ids) also runs for its requests. Inferlo answers moved routes itself, so Koa middleware after it (and code that runs after `await next()` and sets `ctx.body`) does not touch Inferlo's responses.
- To keep the new routes under their own path for a while, use a prefix instead: `koa.use(toKoaMiddleware(inferlo, { prefix: "/v2" }))` serves the app under `/v2` and passes other paths on. To use only Inferlo's AI features in Koa middleware, see [`inferloAI()`](integrations.md#koa).

## 2. Move one route

Before, in Koa with `@koa/router` and a hand-written check:

```ts
router.post("/tickets", requireUser, async (ctx) => {
  const { title, priority = "normal" } = ctx.request.body ?? {};
  if (typeof title !== "string" || title.length < 3 || title.length > 200) ctx.throw(422, "title must be 3 to 200 characters");
  if (!["low", "normal", "urgent"].includes(priority)) ctx.throw(422, "invalid priority");
  const ticket = await tickets.insert({ title, priority, ownerId: ctx.state.user.id });
  ctx.status = 201;
  ctx.body = ticket;
});
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

Then delete the Koa route. Requests to `POST /tickets` now stop at Inferlo, at the same URL.

- The schema replaces the hand-written checks (or `koa-joi-router`, `koa-zod-router` and similar): invalid input gets `422` with IL1001 and every problem listed, and `body` is typed. `query` and `params` schemas convert and check `ctx.query` and `ctx.params`.
- The route is private by default: `user` is the signed-in user (no more `ctx.state.user`), and requests without one get `401` (IL3001). This replaces `requireUser`, `koa-jwt` or `koa-passport` checks. Add `auth: "public"` to routes anyone may call, or a role name such as `auth: "admin"`.
- Return the value instead of setting `ctx.body`; call `status(201)` instead of `ctx.status = 201`. `undefined` sends `204`. Return a `Response` for anything that is not JSON.
- Throw `notFound()`, `forbidden()` or `httpError(409, "...")` instead of `ctx.throw(...)` or `http-errors`.
- The error format changes to Inferlo's `{ "error": { "code", "message", ... } }`. If clients parse error bodies, tell them, or move routes in groups that one client uses.

## 3. Map Koa concepts to Inferlo

| Koa | Inferlo |
|---|---|
| `router.get(path, ...middleware, handler)` (`@koa/router`) | `export const x = route.get(path, options).handle(handler)` in a routes file, registered with `createApp({ routes: [file] })` |
| `ctx.params`, `ctx.query`, `ctx.request.body` | `params`, `query`, `body` in the handler context, validated by schemas ([schemas](schema.md)) |
| `ctx.body = value`, `ctx.status = 201` | `return value` and `status(201)` |
| `ctx.set(name, value)` | `header(name, value)` |
| `ctx.state` | `state` from `createApp({ middleware })`, and `user` from auth |
| `ctx.throw(404)`, `http-errors` | `notFound()`, `forbidden()`, `badRequest()`, `httpError(status, message)` ([errors](routes.md#errors)) |
| Error-handling middleware (`try { await next() } catch`) | Built in: every error becomes the standard error body, and unexpected errors are logged with secrets redacted |
| `koa-compose`, middleware chains per route | `createApp({ middleware })` for cross-cutting code, the route's `auth`, `permission` and `rateLimit` options for checks |
| `koa-jwt`, `koa-passport`, custom auth middleware | `createApp({ auth })` with `bearer(...)` or `auth: { resolve(req) { ... } }`, and the route's `auth` option ([auth](auth.md)) |
| `koa-bodyparser`, `@koa/bodyparser`, `@koa/multer` | Built in for JSON and forms, with `createApp({ maxBodySize })` |
| `@koa/cors` | `createApp({ cors: { origin: [...] } })` |
| `koa-helmet` | Built in: security headers on every response ([security](security.md)) |
| `koa-ratelimit` | The route's `rateLimit: { max, per, by }`, with memory or Postgres stores ([routes](routes.md)) |
| `koa-logger`, request id middleware | `createApp({ logging: { requests: true } })` and `X-Request-Id` ([observability](observability.md)) |
| `koa-mount`, nested routers with a prefix | Route files, grouped into [modules](modules.md); `apiVersion("v1", routes)` for `/v1` ([API versions](routes.md#api-versions)) |
| `koa-swagger-decorator`, `koa2-swagger-ui` | Generated: `GET /openapi.json` from the route schemas |
| `ctx.req` streaming, server-sent events | `return ctx.ai.stream(...).toResponse()` for model output, or a `Response` with a `ReadableStream` |
| `dotenv`, `process.env` | `config({ schema })` in `src/config.ts` ([configuration](config.md)) |
| `supertest(koa.callback())` in tests | `app.request(path, { method, json, as: user })` with a signed-in test user ([testing](testing.md)) |
| `koa.listen(3000)` | `app.listen(3000)` and `app.close()` on SIGTERM ([deployment](deploy.md)) |

`koa-static`, `koa-views` and `koa-session` have no Inferlo equivalent yet: keep them in Koa (they are not routes you need to move), or serve static files from a CDN or reverse proxy.

## 4. Share auth between both

During the migration, Koa and Inferlo routes must accept the same credentials. Put the check in one function and use it from both:

```ts
// src/auth-check.ts
export async function userFromToken(token: string | undefined) {
  if (!token) return null;
  const session = await sessions.findByToken(token); // your existing lookup
  return session ? { id: session.userId, roles: session.roles } : null;
}
```

```ts
// Koa middleware, as before
export const requireUser: Koa.Middleware = async (ctx, next) => {
  const user = await userFromToken(ctx.get("authorization").replace(/^Bearer /, "") || undefined);
  if (!user) ctx.throw(401, "Sign in required");
  ctx.state.user = user;
  await next();
};
```

```ts
// src/inferlo/auth.ts
import { bearer } from "@browserlessapi/inferlo";
import { userFromToken } from "../auth-check.ts";

export const auth = bearer((token) => userFromToken(token));
```

A user needs an `id`, and `roles` for role-based routes. For cookie sessions or other schemes, write `auth: { resolve(req) { ... } }`; `req` is a standard `Request` with the same headers and cookies Koa sees.

## 5. Keep your data layer, then adopt models where they fit

Inferlo handlers can call any database code you already have (Knex, Sequelize, TypeORM, Prisma, Drizzle, a `pg` pool): import it and use it in the handler. You do not have to move data access to switch routes. For writes across your existing tables and new Inferlo models in one transaction, see [Drizzle](integrations.md#drizzle-orm), [Kysely](integrations.md#kysely), [Prisma](integrations.md#prisma), [TypeORM](integrations.md#typeorm) and [Sequelize](integrations.md#sequelize).

For new tables, use Inferlo [models](database.md): validated inserts and updates, typed queries, relations, pagination and generated migrations (`inferlo db migrate`). Inferlo models expect a `uuid` `id`, `created_at` and `updated_at` columns and snake_case column names, so existing tables that differ are best left with your current code.

## 6. Move the tests

```ts
// Before: supertest with a token
const res = await request(koa.callback()).post("/tickets").set("authorization", `Bearer ${token}`).send({ title: "Printer" });

// After: signed in as a test user, without a server
import { readJson } from "@browserlessapi/inferlo/testing";

const res = await app.request("/tickets", { method: "POST", json: { title: "Printer" }, as: { id: "u1", roles: [] } });
const ticket = await readJson(res, 201);
```

Supertest tests against `koa.callback()` keep working during the migration, because moved routes are answered at the same URLs.

## 7. Remove Koa

When the last Koa route is gone, start the Inferlo app directly:

```ts
// src/server.ts
import { app } from "./inferlo/app.ts";

const server = await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Listening on http://localhost:${server.port}`);
process.on("SIGTERM", () => void app.close({ delayMs: 5000 }));
```

Then remove `koa`, `@koa/router`, the body parser and the middleware Inferlo replaced. Compare your app with a new project from `npx @browserlessapi/inferlo new` for the recommended layout, configuration and AGENTS.md for AI coding tools.

## Checklist

- [ ] `koa.use(toKoaMiddleware(inferlo, { fallthrough: true }))` before the Koa router
- [ ] One auth check shared by Koa and Inferlo
- [ ] Each moved route: schemas for its input, the right `auth`, `status(201)` where clients expect it, the Koa route deleted, a test with `app.request`
- [ ] Koa's CORS and helmet middleware scoped to Koa routes (Inferlo sends its own headers)
- [ ] Clients told about the new error format, if they read error bodies
- [ ] Koa removed, `app.listen()` and `app.close()` on SIGTERM

If you only want Inferlo's AI features inside Koa and no migration, use `ctx.ai` from [`@browserlessapi/inferlo/koa`](integrations.md#koa) instead.
