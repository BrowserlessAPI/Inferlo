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
| `rateLimit` | `{ max, per, by }` to limit requests per user, tenant or IP (see below) |
| `deprecated` | `true`, or `{ since, sunset, link }` to send deprecation headers (see below) |
| `cache` | `{ ttlMs, by: "user" \| "public", tags }` to cache a GET route's JSON responses (see [Caching](caching.md#caching-route-responses)) |
| `timeoutMs` | Time limit in milliseconds for this route, or `false` for none. Default: `createApp({ requestTimeoutMs })`, 60000. Slower requests answer 503 IL2007 (see [request timeouts](security.md#request-timeouts)) |

Paths support `:param` segments and a final `*` wildcard (`params["*"]`).

For WebSockets, `route.ws(path, { message, auth, rateLimit }).handle(fn)` runs the handler once per message, with the same auth, permissions and rate limits; see [WebSockets](websockets.md).

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
- `by: "user"` (default) counts each signed-in user; requests without a user (on public routes) count by IP. `by: "tenant"` counts each tenant (organisation) in [multi-tenant apps](database.md#multi-tenancy), so all users of one customer share the limit (`rateLimit: { max: 1000, per: "day", by: "tenant" }` for a plan's quota); users without a tenant are counted one by one. `by: "ip"` counts each client IP.
- The count is checked after auth and before input validation: failed sign-ins on private routes do not use it up, invalid bodies do.
- Over the limit the route answers **429** with IL2005 and a `Retry-After` header. Every response of a limited route has `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` (seconds) headers.
- Tool calls from `ai.generate({ tools })` and the MCP server count too, as the same user.
- Counts are kept in memory by default (one process, tests). With several instances, keep them in Postgres: `createApp({ rateLimit: { store: "database" } })` uses the `inferlo_rate_limits` table, created on first use (IL6008 without Postgres). Or keep them in Redis: `createApp({ redis, rateLimit: { store: "redis" } })` (see [Redis](redis.md)).
- The client IP comes from the server (`app.listen()`, Bun and Deno). Behind a load balancer or proxy, set `createApp({ trustProxy: true })` to use the first `X-Forwarded-For` address; leave it off otherwise, because clients can send that header themselves.
- Invalid options raise IL6007 when the app starts.

## Deprecating routes

When a route is replaced (for example `/v1/tickets` by `/v2/tickets`, see [API versions](#api-versions)), mark the old one deprecated instead of removing it at once, so clients have time to move:

```ts
export const listTicketsV1 = route
  .get("/v1/tickets", {
    deprecated: { since: "2026-11-01", sunset: "2027-06-30", link: "https://example.com/docs/tickets-v2" },
  })
  .handle(...);
```

- Every response of the route, errors included, gets the standard headers that HTTP clients, API gateways and SDK generators read: `Deprecation: @1793491200` ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745), the `since` date as Unix seconds), `Sunset: Wed, 30 Jun 2027 00:00:00 GMT` ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) and `Link: <https://example.com/docs/tickets-v2>; rel="deprecation"; type="text/html"`. Each header is sent only when its option is set.
- `since` and `sunset` are dates (`"2026-11-01"`), ISO timestamps or `Date` values, and `sunset` must be after `since`. `link` is an http or https URL of a page that explains what to use instead.
- `deprecated: true` marks the route deprecated in OpenAPI, describe and MCP without sending headers.
- OpenAPI marks the operation `deprecated: true` (with the dates and link in `x-inferlo-deprecation`), `describe()` and `inferlo describe` show it, and MCP tool descriptions end with "(Deprecated, stops working on 2027-06-30.)" so AI agents prefer other tools.
- The route keeps working after the sunset date; remove it when you are ready.
- Invalid options raise IL6021 when the app starts, naming the route.

## API versions

When a change would break clients, publish a new API version next to the old one with `apiVersion(version, routes)`:

```ts
import { apiVersion, createApp } from "@browserlessapi/inferlo";
import * as ticketsV1 from "./routes/v1/tickets.ts"; // the old list response
import * as tickets from "./routes/tickets.ts";       // current routes
import * as account from "./routes/account.ts";       // the same in every version

export const app = createApp({
  routes: [
    apiVersion("v1", [ticketsV1, account], { deprecated: { since: "2026-11-01", sunset: "2027-06-30", link: "https://example.com/docs/v2" } }),
    apiVersion("v2", [tickets, account]),
    [auth],                                           // outside every version: /login
  ],
});
```

- Routes are written without the prefix (`route.get("/tickets")`) and served under it: `GET /v1/tickets` and `GET /v2/tickets`. Versions are `"v"` and a number (`"v1"`, `"v2"`).
- A route that did not change goes in several versions (`account` above). Each version gets its own copy under its prefix, so clients of every version reach it at their own base URL.
- Routes in a version are named `<version>_<export name>` (`v1_listTickets`), so OpenAPI operation ids and MCP tool names stay unique.
- `deprecated` on the version marks every route in it, with the Deprecation, Sunset and Link headers described [above](#deprecating-routes). A route's own `deprecated` option wins.
- Each version gets its own OpenAPI document at `/<version>/openapi.json` (`/v1/openapi.json`, following `createApp({ openapi })`), with its routes and the routes outside every version; `app.openapi({ version: "v1" })` returns it. `/openapi.json` still lists every route. SDK generators and API gateways can then be pointed at one version.
- `describe()` lists the versions with the path of each document and gives each route its `version`. Versions work inside [modules](modules.md) too: `module("tickets", { routes: [apiVersion("v2", [tickets])] })`.
- Invalid arguments, a route already in a version, an unknown version in `app.openapi()` and a `GET` route on a version's document path raise IL6025.

## The handler context

| Property | |
|---|---|
| `body`, `query`, `params` | Validated, typed input |
| `user` | The signed-in user (`null` only on public routes without a session) |
| `db` | Typed tables |
| `ai` | `generate`, `stream`, `embed` |
| `jobs` | `enqueue` background jobs (see [Jobs](jobs.md)) |
| `cache` | `getOrSet`, `get`, `set`, `delete`, `invalidate` (see [Caching](caching.md)) |
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
