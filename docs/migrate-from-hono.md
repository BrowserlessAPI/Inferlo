# Migrate from Hono

This guide moves an existing Hono app to Inferlo one route at a time. The app keeps running, on the same runtime (Node.js, Bun, Deno or Cloudflare Workers), and keeps its URLs during the whole migration: Hono answers the routes you have not moved yet, Inferlo answers the rest. Nothing has to be rewritten in one go.

Both are built on Web standards (`Request`, `Response`, `fetch`), and Inferlo's routes look like Hono's on purpose, so most handlers move with small changes. What you gain on every route you move: validation and types from one schema without a separate validator middleware, routes private by default, the same error format everywhere (`ILxxxx` codes), a database layer with migrations, rate limits, background jobs, an OpenAPI document and an MCP server generated from the routes, and AI models through `ctx.ai`. See [comparison](comparison.md) for the bigger picture.

## 1. Add Inferlo next to Hono

```bash
npm install @browserlessapi/inferlo
```

Create an empty Inferlo app beside your Hono code, for example in `src/inferlo/app.ts`:

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

Pass every request Hono does not answer to Inferlo, with a catch-all **after** all your Hono routes:

```ts
// src/index.ts (your existing Hono entry point)
import { Hono } from "hono";
import { app as inferlo } from "./inferlo/app.ts";

const hono = new Hono();

hono.get("/users/:id", getUser);     // not moved yet: Hono answers
hono.route("/books", books);         // sub-apps too

hono.all("*", (c) => inferlo.fetch(c.req.raw)); // last: everything else goes to Inferlo, including 404s

export default hono;
```

Hono matches routes in the order they were added, so its own routes win and every other request, including other methods on the same path, reaches Inferlo with the original `Request`. Inferlo routes it, or answers `404` with IL2001. Inferlo reads the body itself; keep Hono middleware that reads bodies (validators) on Hono routes only, not on `*`.

Middleware added with `hono.use(...)` before the catch-all also runs for Inferlo's requests. That is fine for logging; for CORS, security headers and request ids, Inferlo has its own (step 3), so scope Hono's to the Hono routes or remove it once Inferlo answers most routes.

If you would rather keep the new routes under their own path for a while, mount the app there instead: `hono.mount("/v2", inferlo.fetch)` (Hono removes `/v2` before Inferlo sees the path). To use only Inferlo's AI features in Hono handlers, see [`inferloAI()`](integrations.md#hono).

## 2. Move one route

Before, in Hono with Zod and `@hono/zod-validator`:

```ts
hono.post(
  "/tickets",
  requireUser,
  zValidator("json", z.object({
    title: z.string().min(3).max(200),
    priority: z.enum(["low", "normal", "urgent"]).default("normal"),
  })),
  async (c) => {
    const body = c.req.valid("json");
    const ticket = await tickets.insert({ ...body, ownerId: c.get("user").id });
    return c.json(ticket, 201);
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

Then delete the Hono route. Requests to `POST /tickets` now reach Inferlo, at the same URL.

- `t.*` schemas read like Zod: `z.string().min(3)` is `t.string().min(3)`, `z.enum([...])` is `t.enum([...])`, `.optional()` and `.default()` are the same. The schema replaces the validator middleware: invalid input gets `422` with IL1001 and every problem listed, and `body` is typed. `query` and `params` schemas replace the `"query"` and `"param"` validators.
- The route is private by default: `user` is the signed-in user, and requests without one get `401` (IL3001). This replaces `requireUser`, `bearerAuth` or `jwt` middleware. Add `auth: "public"` to routes anyone may call, or a role name such as `auth: "admin"`.
- Return the value instead of `c.json(value)`; call `status(201)` instead of `c.json(value, 201)`. `undefined` sends `204`. A `Response` is sent as it is, so `return c.body(...)` style code becomes `return new Response(...)`.
- Throw `notFound()`, `forbidden()` or `httpError(409, "...")` instead of `HTTPException`.
- The error format changes to Inferlo's `{ "error": { "code", "message", ... } }`. If clients parse error bodies, tell them, or move routes in groups that one client uses.

## 3. Map Hono concepts to Inferlo

| Hono | Inferlo |
|---|---|
| `hono.get(path, handler)` | `export const x = route.get(path, options).handle(handler)` in a routes file, registered with `createApp({ routes: [file] })` |
| `c.req.param()`, `c.req.query()`, `await c.req.json()` | `params`, `query`, `body` in the handler context, validated by schemas ([schemas](schema.md)) |
| `zValidator`, `validator()` | `body`, `query` and `params` options with `t.*` schemas |
| `c.json(value, status)`, `c.text()`, `c.body()` | `return value` and `status(code)`; return a `Response` for anything else |
| `c.header(name, value)` | `header(name, value)` |
| `c.set()` and `c.get()`, `c.var` | `state` from `createApp({ middleware })`, and `user` from auth |
| `HTTPException` | `httpError(status, message)`, `notFound()`, `forbidden()`, `badRequest()` ([errors](routes.md#errors)) |
| `hono/bearer-auth`, `hono/jwt`, `hono/basic-auth` | `createApp({ auth })` with `bearer(...)` or `auth: { resolve(req) { ... } }`, and the route's `auth` option ([auth](auth.md)) |
| `hono/cors` | `createApp({ cors: { origin: [...] } })` |
| `hono/secure-headers` | Built in: security headers on every response ([security](security.md)) |
| `hono/logger`, `hono/request-id` | `createApp({ logging: { requests: true } })` and `X-Request-Id` ([observability](observability.md)) |
| `hono/timeout` | `createApp({ requestTimeoutMs })` and the route's `timeoutMs` ([security](security.md#request-timeouts)) |
| `hono.route("/books", books)` sub-apps | Route files, grouped into [modules](modules.md) for larger features |
| `basePath("/v1")` | `apiVersion("v1", routes)`, with an OpenAPI document per version ([API versions](routes.md#api-versions)) |
| `@hono/zod-openapi`, `@hono/swagger-ui` | Generated: `GET /openapi.json` from the route schemas |
| Hono RPC (`hc<AppType>`) | The OpenAPI document for client generators; MCP tools for AI agents |
| `hono/streaming` (`streamSSE`) | `return ctx.ai.stream(...).toResponse()` for model output, or a `Response` with a `ReadableStream` |
| `c.env` bindings and `process.env` | `config({ schema })` in `src/config.ts` ([configuration](config.md)) |
| `app.request()` in tests | `app.request(path, { method, json, as: user })` with a signed-in test user ([testing](testing.md)) |
| `export default hono` | `export default app` (Bun, Deno, Workers) or `app.listen()` on Node.js ([deployment](deploy.md)) |

## 4. Share auth between both

During the migration, Hono and Inferlo routes must accept the same credentials. Put the check in one function and use it from both:

```ts
// src/auth-check.ts
export async function userFromToken(token: string | undefined) {
  if (!token) return null;
  const session = await sessions.findByToken(token); // your existing lookup
  return session ? { id: session.userId, roles: session.roles } : null;
}
```

```ts
// Hono middleware, as before
export const requireUser = createMiddleware(async (c, next) => {
  const user = await userFromToken(c.req.header("authorization")?.replace(/^Bearer /, ""));
  if (!user) return c.json({ error: "Sign in required" }, 401);
  c.set("user", user);
  await next();
});
```

```ts
// src/inferlo/auth.ts
import { bearer } from "@browserlessapi/inferlo";
import { userFromToken } from "../auth-check.ts";

export const auth = bearer((token) => userFromToken(token));
```

A user needs an `id`, and `roles` for role-based routes. For cookies or other schemes, write `auth: { resolve(req) { ... } }`; `req` is the same standard `Request` Hono gives you as `c.req.raw`.

## 5. Keep your data layer, then adopt models where they fit

Inferlo handlers can call any database code you already have (Drizzle, Prisma, Kysely, a D1 or Postgres client): import it and use it in the handler. You do not have to move data access to switch routes.

For new tables, use Inferlo [models](database.md): validated inserts and updates, typed queries, relations, pagination and generated migrations (`inferlo db migrate`). Inferlo models expect a `uuid` `id`, `created_at` and `updated_at` columns and snake_case column names, so existing tables that differ are best left with your current code.

## 6. Move the tests

```ts
// Before: Hono's app.request with a token
const res = await hono.request("/tickets", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Printer" }) });

// After: signed in as a test user, JSON body without headers
import { readJson } from "@browserlessapi/inferlo/testing";

const res = await app.request("/tickets", { method: "POST", json: { title: "Printer" }, as: { id: "u1", roles: [] } });
const ticket = await readJson(res, 201);
```

Tests through the Hono app (`hono.request(...)`) keep working during the migration, because the catch-all passes requests on to Inferlo.

## 7. Remove Hono

When the last Hono route is gone, export the Inferlo app instead:

```ts
// src/index.ts on Bun, Deno or Cloudflare Workers
import { app } from "./inferlo/app.ts";
export default app;
```

```ts
// src/server.ts on Node.js
import { app } from "./inferlo/app.ts";

const server = await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Listening on http://localhost:${server.port}`);
process.on("SIGTERM", () => void app.close({ delayMs: 5000 }));
```

Then remove `hono`, its validator and OpenAPI packages and the middleware Inferlo replaced. Compare your app with a new project from `npx @browserlessapi/inferlo new` for the recommended layout, configuration and AGENTS.md for AI coding tools.

## Checklist

- [ ] `hono.all("*", (c) => inferlo.fetch(c.req.raw))` after every Hono route
- [ ] One auth check shared by Hono and Inferlo
- [ ] Each moved route: schemas for its input, the right `auth`, `status(201)` where clients expect it, the Hono route deleted, a test with `app.request`
- [ ] Hono's CORS and security header middleware scoped to Hono routes (Inferlo sends its own)
- [ ] Clients told about the new error format, if they read error bodies
- [ ] Hono removed, `export default app` (or `app.listen()` and `app.close()` on Node.js)

If you only want Inferlo's AI features inside Hono and no migration, use `c.var.ai` from [`@browserlessapi/inferlo/hono`](integrations.md#hono) instead.
