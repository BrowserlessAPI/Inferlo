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
| `body` | Request body schema (JSON, form-encoded, or multipart/form-data with `t.file()` fields; see [File uploads](#file-uploads)) |
| `query` | Query string schema. Values are converted to numbers and booleans; unknown keys ignored |
| `params` | Path parameter schema. Without it, params are strings |
| `response` | Response schema for OpenAPI, also checked against the handler's answer outside production (see [Response validation](#response-validation)) |
| `summary`, `description`, `tags` | Documentation for OpenAPI, describe and MCP |
| `tool` | `true` or `{ name, description }` to expose the route as an MCP tool |
| `rateLimit` | `{ max, per, by }` to limit requests per user, tenant or IP (see below) |
| `deprecated` | `true`, or `{ since, sunset, link }` to send deprecation headers (see below) |
| `cache` | `{ ttlMs, by: "user" \| "public", tags }` to cache a GET route's JSON responses (see [Caching](caching.md#caching-route-responses)) |
| `idempotency` | `true`, or `{ ttlMs, required }`, so a POST, PUT, PATCH or DELETE request retried with the same `Idempotency-Key` header runs once (see [Idempotency keys](#idempotency-keys)) |
| `webhook` | `{ scheme: "standard" \| "stripe" \| "github", secret, toleranceMs }` to accept only requests signed by a webhook sender (see [Webhooks](#webhooks)) |
| `timeoutMs` | Time limit in milliseconds for this route, or `false` for none. Default: `createApp({ requestTimeoutMs })`, 60000. Slower requests answer 503 IL2007 (see [request timeouts](security.md#request-timeouts)) |

Paths support `:param` segments and a final `*` wildcard (`params["*"]`).

For WebSockets, `route.ws(path, { message, auth, rateLimit }).handle(fn)` runs the handler once per message, with the same auth, permissions and rate limits; see [WebSockets](websockets.md).

## File uploads

A `t.file()` field in the body makes the route take `multipart/form-data`, and the handler gets a web `File`:

```ts
export const uploadAvatar = route
  .post("/me/avatar", {
    body: t.object({
      avatar: t.file({ maxBytes: 2 * 1024 * 1024, types: ["image/png", "image/jpeg"] }),
      caption: t.string().max(200).optional(),
    }),
  })
  .handle(async ({ body, user }) => {
    const bytes = new Uint8Array(await body.avatar.arrayBuffer());
    // Keep the file with ctx.storage (see storage.md), then keep the key in a t.string() field of a model.
    return { name: body.avatar.name, size: body.avatar.size, type: body.avatar.type, by: user.id };
  });

export const attach = route
  .post("/tickets/:id/attachments", { params: IdParams, body: t.object({ files: t.array(t.file({ maxBytes: 5_000_000 })).max(10) }) })
  .handle(({ body }) => ({ count: body.files.length }));
```

- `t.file({ maxBytes, types })`: `maxBytes` defaults to 10 MiB; `types` lists accepted media types, exact (`"image/png"`) or by family (`"image/*"`), and defaults to any type. Several files: `t.array(t.file()).max(n)` (the `.max(n)` is required).
- Limits are checked before the handler runs. The body is read as it streams in and cut off with **413 IL2004** once it passes `maxBodySize` (the text fields) plus every file field's `maxBytes` (times `.max(n)` for lists), so a huge upload is never read into memory. Then each file is checked: too large (`file_too_large`), a type not in `types` (`file_type`), or, for PNG, JPEG, GIF, WebP, PDF and ZIP, content that does not match the declared type (`file_content`: a script sent as `image/png` is refused). These answer **422 IL1001** with the field's path in `details`.
- The other fields of the form are strings, converted to numbers, booleans and dates like query strings. A field sent several times becomes a list; a file input left empty in an HTML form counts as left out, so `.optional()` works.
- Files arrive in memory as `File` objects (up to the limits above); keep them with [`ctx.storage`](storage.md) (`` await storage.put(`avatars/${user.id}`, body.avatar) ``) in the handler or a job. Files can only be top-level fields of a route body: not in models (store the file elsewhere and keep its key in a `t.string()`), query strings or responses, and a route with files cannot be an MCP or AI tool. These raise IL1004 when the app starts. A body that is not valid multipart answers 400 IL2015.
- Clients send a `FormData` without setting `Content-Type` themselves (fetch adds the boundary): `fetch("/me/avatar", { method: "POST", body: formData })`. In tests: `app.request("/me/avatar", { method: "POST", body: formData, as: user })`. HTML forms need `enctype="multipart/form-data"`; with [cookie sessions](auth.md#cookie-sessions), put the hidden `_csrf` field before the file inputs.
- OpenAPI describes the body as `multipart/form-data` with `format: binary` file fields and their accepted types in `encoding`, and `inferlo describe` shows `bodyType: "multipart/form-data"`.

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
- Counts are kept in memory by default (one process, tests). With several instances, keep them in the database: `createApp({ rateLimit: { store: "database" } })` uses the `inferlo_rate_limits` table of the app's Postgres or MySQL database, created on first use (IL6008 with another adapter). Or keep them in Redis: `createApp({ redis, rateLimit: { store: "redis" } })` (see [Redis](redis.md)).
- The client IP comes from the server (`app.listen()`, Bun and Deno). Behind a load balancer or proxy, set `createApp({ trustProxy: true })` to use the first `X-Forwarded-For` address; leave it off otherwise, because clients can send that header themselves.
- Invalid options raise IL6007 when the app starts.

## Idempotency keys

Clients retry requests after a timeout or a dropped connection. For requests that must not happen twice (a payment, an order, a sent email), let the client send an `Idempotency-Key` header and turn on `idempotency`:

```ts
export const createOrder = route
  .post("/orders", { body: NewOrder, idempotency: true })   // or { ttlMs: 86_400_000, required: true }
  .handle(async ({ body, db, status }) => {
    status(201);
    return db.orders.create(body);
  });
```

```ts
// Client: a new key per order, the same key when retrying it.
const key = crypto.randomUUID();
await fetch("/orders", { method: "POST", headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body });
```

- The first request with a key runs the handler. Repeats with the same key on the same route, from the same user, get the first answer (status, headers and body) with `Idempotent-Replayed: true`, without running the handler, for `ttlMs` (default 24 hours, at most 30 days).
- A repeat that arrives while the first request still runs answers **409** IL2018 (retry it a moment later). A key used again with a different request (another body, query or path) answers **422** IL2019.
- Errors and 5xx answers release the key, so the client can retry. Answers that set a cookie, event streams (`text/event-stream`) and bodies over 1 MB are not stored: repeats of them answer 409 IL2018.
- Without the header the request runs as usual; with `required: true` it answers **400** IL2017. Keys are 1 to 255 visible ASCII characters (send a UUID).
- Keys are kept in the app cache (`createApp({ cache: { store } })`), claimed atomically, so with the database or Redis store a key runs once across every instance. Keys of requests without a user are shared by everyone, so clients must send random keys.
- The check runs after auth, permissions, rate limits and input validation, so repeats are counted by the rate limit and invalid requests never claim a key. OpenAPI lists the `Idempotency-Key` header. Only POST, PUT, PATCH and DELETE routes take the option; anything else raises IL6058 when the app starts.

## Webhooks

Payment providers, identity providers and code hosts call your app with webhooks. Anyone can send a request to a public URL, so a webhook route checks the sender's signature before it trusts the body:

```ts
export const stripeEvents = route
  .post("/webhooks/stripe", {
    auth: "public",
    webhook: { scheme: "stripe", secret: settings.STRIPE_WEBHOOK_SECRET },
    // Senders add fields to their events over time: strip() drops the ones not listed instead of refusing them.
    body: t.object({ id: t.string(), type: t.string() }).strip(),
  })
  .handle(async ({ body, jobs }) => {
    if (body.type === "invoice.paid") await jobs.enqueue(markPaid, { eventId: body.id });
    return { received: true };
  });
```

| `scheme` | Senders | Headers |
|---|---|---|
| `"standard"` | [Standard Webhooks](https://www.standardwebhooks.com) senders: Svix, Clerk, Resend, Supabase, OpenAI and others; secrets look like `whsec_...` | `webhook-id`, `webhook-timestamp`, `webhook-signature` |
| `"stripe"` | Stripe | `Stripe-Signature` |
| `"github"` | GitHub (and Gitea and Forgejo, which send the same header) | `X-Hub-Signature-256` |

- The HMAC-SHA256 signature is checked over the exact bytes of the request body, before the body is parsed or validated and before the handler runs. Comparisons use Web Crypto (constant time).
- Unsigned requests, wrong signatures, bodies changed after signing and, for `"standard"` and `"stripe"`, timestamps more than `toleranceMs` (default 300000, 5 minutes) from now answer `401` with IL3012, without saying which check failed. The timestamp is part of the signature, so a captured request cannot be replayed later.
- `secret` can be a list during a rotation: `secret: [settings.WEBHOOK_SECRET, settings.WEBHOOK_SECRET_PREVIOUS]`; any one may match. Keep secrets in `config({ secrets })` so they never reach the logs.
- Webhook routes need `auth: "public"` (the sender proves itself with the signature) and are POST, PUT or PATCH routes; they cannot be AI tools or take file uploads. A missing secret (an unset environment variable), an unknown scheme or another invalid option raises IL6066 at startup.
- Give the body schema `.strip()` (on nested objects too): providers add fields to their events, and a schema that refuses unknown fields would answer 422 to them.
- Senders retry deliveries, so do slow work in a [background job](jobs.md) and answer quickly. GitHub signatures have no timestamp; skip deliveries you have seen by their `X-GitHub-Delivery` id when a repeat would matter.
- `describe()` and `inferlo describe` show `webhook: "stripe"` (the scheme, never the secret) for each webhook route.

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

## Response validation

A route's `response` schema documents its answer in OpenAPI and MCP, and Inferlo also checks the answer against it while you develop, so a missing field, a wrong type or a field that should not be sent (such as `passwordHash`, because object schemas reject unknown fields) shows up before clients see it:

```ts
const Profile = t.object({ id: t.uuid(), email: t.email(), name: t.string() });

export const me = route.get("/me", { response: Profile }).handle(async ({ db, user }) => {
  const row = await db.users.find(user.id);
  return { id: row!.id, email: row!.email, name: row!.name }; // not the whole row
});
```

- `createApp({ validateResponses })`: `"warn"` (the default, unless the environment is production) sends the answer and logs `IL2016 GET /me: the response does not match ...` with the mismatched fields, once per route; `"error"` answers 500 IL2016 with the fields in `details` instead, for tests; `false` turns the check off.
- The environment is `INFERLO_ENV`, then `NODE_ENV`; with `"production"` the default is `false`, so production pays nothing for the check.
- The answer is checked as clients receive it (JSON, so dates are ISO strings), only for 2xx JSON answers of routes with a `response` schema. `Response` objects, empty (204) answers and errors are not checked. Values are never logged or sent, only field paths and what was expected.
- A model's row schema matches the rows it returns: `response: Ticket.row` (or `t.array(Ticket.row)`) accepts the fields Inferlo sets (`id`, `createdAt`, `updatedAt`, `tenantId`), which request bodies may never send, and `null` in `.optional()` fields, which rows have for columns left out.
- Invalid `validateResponses` values raise IL6040 when the app starts.

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
