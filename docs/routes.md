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
| `rateLimit` | `{ max, per, by }` to limit requests per user or IP (see below) |
| `timeoutMs` | Time limit in milliseconds for this route, or `false` for none. Default: `createApp({ requestTimeoutMs })`, 60000. Slower requests answer 503 IL2007 (see [request timeouts](security.md#request-timeouts)) |

Paths support `:param` segments and a final `*` wildcard (`params["*"]`).

## Rate limiting

```ts
export const login = route
  .post("/login", { auth: "public", body: Login, rateLimit: { max: 5, per: "minute", by: "ip" } })
  .handle(...);

export const summarize = route
  .post("/notes/:id/summary", { params: IdParams, rateLimit: { max: 20, per: "hour" } })   // by: "user" is the default
  .handle(...);
```

- `max` requests per `per` (`"second"`, `"minute"`, `"hour"` or `"day"`), in fixed windows, counted separately for each route.
- `by: "user"` (default) counts each signed-in user; requests without a user (on public routes) count by IP. `by: "ip"` counts each client IP.
- The count is checked after auth and before input validation: failed sign-ins on private routes do not use it up, invalid bodies do.
- Over the limit the route answers **429** with IL2005 and a `Retry-After` header. Every response of a limited route has `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds) headers.
- Tool calls from `ai.generate({ tools })` and the MCP server count too, as the same user.
- Counts are kept in memory by default (one process, tests). With several instances, keep them in Postgres: `createApp({ rateLimit: { store: "database" } })` uses the `inferlo_rate_limits` table, created on first use (IL6008 without Postgres).
- The client IP comes from the server (`app.listen()`, Bun and Deno). Behind a load balancer or proxy, set `createApp({ trustProxy: true })` to use the first `X-Forwarded-For` address; leave it off otherwise, because clients can send that header themselves.
- Invalid options raise IL6007 when the app starts.

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
| `signal` | `AbortSignal` aborted when the request times out or the client disconnects. `ai` calls use it automatically; pass it to `fetch` and other slow work |
| `requestId` | This request's id, also in the `X-Request-Id` response header and in its log entries (see [Observability](observability.md)) |
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
