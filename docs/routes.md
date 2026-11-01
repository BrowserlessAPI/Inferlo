# Routes

```ts
import { route, t, notFound } from "@browserlessapi/inferlo";

export const getTicket = route
  .get("/tickets/:id", {
    params: t.object({ id: t.uuid() }),
    summary: "Get one ticket",
    tool: true,
  })
  .handle(async ({ params, user, db }) => {
    const ticket = await db.tickets.get(params.id);
    if (ticket.ownerId !== user.id) throw notFound();
    return ticket;
  });
```

Methods: `route.get`, `route.post`, `route.put`, `route.patch`, `route.delete`. HEAD is answered by GET routes.

## Options

| Option | Purpose |
|---|---|
| `auth` | `"user"` (default, signed in), `"public"`, or a role name such as `"admin"` |
| `body` | Request body schema (JSON or form-encoded) |
| `query` | Query string schema. Values are converted to numbers and booleans; unknown keys ignored |
| `params` | Path parameter schema. Without it, params are strings |
| `response` | Response schema for OpenAPI |
| `summary`, `description`, `tags` | Documentation for OpenAPI, describe and MCP |
| `tool` | `true` or `{ name, description }` to expose the route as an MCP tool |

Paths support `:param` segments and a final `*` wildcard (`params["*"]`).

## The handler context

| Property | |
|---|---|
| `body`, `query`, `params` | Validated, typed input |
| `user` | The signed-in user (`null` only on public routes without a session) |
| `db` | Typed tables |
| `ai` | `generate`, `stream`, `embed` |
| `req`, `url`, `headers` | The raw request |
| `status(code)` | Set the status code |
| `header(name, value)` | Set a response header |
| `state` | Per-request values from middleware |
| `waitUntil(promise)` | Work that continues after the response |

## Return values

- Any value is sent as JSON with status 200 (or the code from `status()`).
- `undefined` sends 204 No Content.
- A `Response` is sent as is (files, redirects, streams, `ai.stream(...).toResponse()`).

## Errors

```ts
import { notFound, forbidden, badRequest, httpError } from "@browserlessapi/inferlo";

throw notFound("Ticket not found");
throw forbidden();
throw badRequest("Pick a future date");
throw httpError(409, "Already paid", { code: "PAYMENT_DONE" });
```

## Registering routes

Export each route as a `const`, then pass the modules:

```ts
import * as tickets from "./routes/tickets.ts";
import * as users from "./routes/users.ts";

createApp({ routes: [tickets, users] });
```

The export name (`getTicket`) becomes the route name used by MCP tools, OpenAPI `operationId` and `inferlo describe`.

## Middleware

```ts
createApp({
  middleware: [
    async ({ req, state }, next) => {
      const started = Date.now();
      const res = await next();
      res.headers.set("x-response-time", `${Date.now() - started}ms`);
      return res;
    },
  ],
});
```

## CORS

```ts
createApp({ cors: { origin: ["https://app.example.com"], credentials: true } });
```
