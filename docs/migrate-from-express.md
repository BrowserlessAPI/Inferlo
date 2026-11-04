# Migrate from Express

This guide moves an existing Express app to Inferlo one route at a time. The app keeps running and keeps its URLs during the whole migration: Express answers the routes you have not moved yet, Inferlo answers the rest, and both run in the same process. Nothing has to be rewritten in one go.

What you gain on every route you move: input validation with typed `body`, `query` and `params`, routes private by default, the same error format everywhere (`ILxxxx` codes), rate limits, request timeouts, an OpenAPI document and an MCP server generated from the routes, in-process tests, and AI models through `ctx.ai`. See [comparison](comparison.md) for the bigger picture.

## 1. Add Inferlo next to Express

```bash
npm install @browserlessapi/inferlo
```

Create an empty Inferlo app beside your Express code, for example in `src/inferlo/app.ts`:

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

Mount it **after** your Express routes and **before** your Express 404 and error handlers:

```ts
// src/server.ts (your existing Express entry point)
import express from "express";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app as inferlo } from "./inferlo/app.ts";

const server = express();
server.use(express.json());

server.get("/users/:id", getUser);        // not moved yet: Express answers
server.post("/users", createUser);

server.use(toNodeHandler(inferlo));       // everything else: Inferlo answers, including 404s

server.listen(3000);
```

Express tries its own routes first. A request that no Express route answers goes to Inferlo, which routes it, or answers `404` with IL2001. Bodies already read by `express.json()` are passed on to Inferlo, so the order of body parsers does not matter. Your Express 404 handler is no longer reached, because Inferlo answers every request it gets; keep your Express error handler for errors thrown by Express routes.

If you would rather keep the new routes under their own path for a while, mount the app there instead: `server.use("/v2", toNodeHandler(inferlo))` (Express removes `/v2` before Inferlo sees the path). See [toNodeHandler](integrations.md#nodejs-frameworks-tonodehandler).

## 2. Move one route

Before, in Express:

```ts
server.post("/tickets", requireUser, async (req, res, next) => {
  try {
    const { title, priority } = req.body;
    if (typeof title !== "string" || title.length < 3 || title.length > 200) {
      return res.status(400).json({ error: "title must be 3 to 200 characters" });
    }
    if (priority && !["low", "normal", "urgent"].includes(priority)) {
      return res.status(400).json({ error: "invalid priority" });
    }
    const ticket = await tickets.insert({ title, priority: priority ?? "normal", ownerId: req.user.id });
    res.status(201).json(ticket);
  } catch (error) {
    next(error);
  }
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

Then delete the Express route. Requests to `POST /tickets` now reach Inferlo, at the same URL.

- The route is private by default: `user` is the signed-in user, and requests without one get `401` (IL3001). Add `auth: "public"` to routes anyone may call, or a role name such as `auth: "admin"`.
- Invalid input gets `422` with IL1001 and every problem listed, before the handler runs. `body` is typed from the schema.
- A returned value is sent as JSON; `undefined` sends `204`. Thrown errors become JSON errors; there is no `next(error)`.
- The response format changes from your own error bodies to Inferlo's `{ "error": { "code", "message", ... } }`. If clients parse error bodies, tell them, or move routes in groups that one client uses.

Move routes in any order. A good order is: new routes first, then simple reads, then writes, then the routes with the most custom middleware.

## 3. Map Express concepts to Inferlo

| Express | Inferlo |
|---|---|
| `server.get(path, handler)` | `export const x = route.get(path, options).handle(handler)` in a routes module, registered with `createApp({ routes: [module] })` |
| `req.params`, `req.query`, `req.body` | `params`, `query`, `body`, validated by `params`, `query` and `body` schemas ([schemas](schema.md)) |
| `res.json(value)`, `res.status(201).json(value)` | `return value`; `status(201); return value` |
| `res.sendStatus(204)` | `return` (or `return undefined`) |
| `res.set(name, value)` | `header(name, value)` |
| `res.redirect(url)`, `res.sendFile(...)`, streams | Return a `Response`: `return Response.redirect(url, 302)` |
| `next(error)`, error-handling middleware | `throw notFound()`, `throw forbidden()`, `throw httpError(409, "Already paid")` ([errors](routes.md#errors)) |
| Joi, Zod, express-validator | `t.*` schemas, close to Zod |
| Passport, JWT or session middleware | `createApp({ auth: { resolve(req) { ... } } })` and the route's `auth` option ([auth](auth.md)) |
| `cors` | `createApp({ cors: { origin: [...] } })` |
| `helmet` | Built in: security headers on every response ([security](security.md)) |
| `express-rate-limit` | `rateLimit: { max: 10, per: "minute" }` on the route ([rate limiting](routes.md#rate-limiting)) |
| `morgan` | `createApp({ logging: { requests: true } })` ([observability](observability.md)) |
| `prom-client` with route labels | `createApp({ metrics: { token } })` ([metrics](observability.md#metrics)) |
| `dotenv` and `process.env` | `config({ schema })` in `src/config.ts` ([configuration](config.md)) |
| `swagger-jsdoc` and comments | Generated: `GET /openapi.json` |
| `supertest` | `await app.request("/tickets", { method: "POST", json: {...}, as: user })` ([testing](testing.md)) |
| `server.close()` on SIGTERM | `await app.close({ delayMs: 5000 })` ([graceful shutdown](deploy.md#graceful-shutdown)) |
| Your own middleware | `createApp({ middleware: [async (ctx, next) => ...] })` ([middleware](routes.md#middleware)) |

## 4. Share auth between both

During the migration, Express and Inferlo routes must accept the same credentials. Put the check in one function and use it from both:

```ts
// src/auth-check.ts
export async function userFromToken(token: string | undefined) {
  if (!token) return null;
  const session = await sessions.findByToken(token); // your existing lookup
  return session ? { id: session.userId, roles: session.roles } : null;
}
```

```ts
// Express middleware, as before
export const requireUser: express.RequestHandler = async (req, res, next) => {
  const user = await userFromToken(req.get("authorization")?.replace(/^Bearer /, ""));
  if (!user) return res.status(401).json({ error: "Sign in required" });
  req.user = user;
  next();
};
```

```ts
// src/inferlo/auth.ts
import { bearer } from "@browserlessapi/inferlo";
import { userFromToken } from "../auth-check.ts";

export const auth = bearer((token) => userFromToken(token));
```

`bearer()` reads `Authorization: Bearer <token>` (or `X-Api-Key`). For cookies or other schemes, write `auth: { resolve(req) { ... } }`: `req` is a standard `Request`, so read headers with `req.headers.get("cookie")`. A user needs an `id`, and `roles` for role-based routes.

## 5. Keep your data layer, then adopt models where they fit

Inferlo handlers can call any database code you already have (an ORM, a query builder, `pg`): import it and use it in the handler, as in step 2. You do not have to move data access to switch routes.

For new tables, use Inferlo [models](database.md): validated inserts and updates, typed queries, relations, pagination and generated migrations (`inferlo db migrate`). Inferlo models expect a `uuid` `id`, `created_at` and `updated_at` columns and snake_case column names, so existing tables that differ are best left with your current code.

## 6. Move the tests

```ts
// Before: supertest against the Express app
await request(server).post("/tickets").set("authorization", `Bearer ${token}`).send({ title: "Printer" }).expect(201);

// After: in-process, no server or port, signed in as a test user
import { readJson } from "@browserlessapi/inferlo/testing";

const res = await app.request("/tickets", { method: "POST", json: { title: "Printer" }, as: { id: "u1", roles: [] } });
const ticket = await readJson(res, 201);
```

Tests through the Express server (`supertest`) keep working during the migration, because the Inferlo app is mounted in it.

## 7. Remove Express

When the last Express route is gone, start the Inferlo app directly and remove the Express server:

```ts
// src/server.ts
import { app } from "./inferlo/app.ts";

const server = await app.listen(Number(process.env.PORT ?? 3000));
console.log(`Listening on http://localhost:${server.port}`);
process.on("SIGTERM", () => void app.close({ delayMs: 5000 }));
```

Then `npm uninstall express` and the middleware packages Inferlo replaced (`cors`, `helmet`, `express-rate-limit`, `morgan`, body parsers). Compare your app with a new project from `npx @browserlessapi/inferlo new` for the recommended layout, configuration and AGENTS.md for AI coding tools.

## Checklist

- [ ] Inferlo app mounted after the Express routes with `toNodeHandler(app)`
- [ ] One auth check shared by Express and Inferlo
- [ ] Each moved route: schemas for its input, the right `auth`, the Express route deleted, a test with `app.request`
- [ ] Clients told about the new error format, if they read error bodies
- [ ] Express removed, `app.listen()` and `app.close()` in `src/server.ts`

If you only want Inferlo's AI features inside Express and no migration, use `req.ai` from [`@browserlessapi/inferlo/express`](integrations.md#express-1) instead.
