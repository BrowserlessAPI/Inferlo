# Service-to-service calls

When an Inferlo app is split into several services, one service calls another's routes with `serviceClient`. The route definition is the contract: the call gets its method, path and types from the route itself, so a renamed field or a missing parameter is a type error in the caller, not a 422 in production. Nothing is generated and nothing is global.

```ts
// orders/src/clients.ts
import { serviceClient } from "@browserlessapi/inferlo";
import { settings } from "./config.ts";

export const tickets = serviceClient({
  baseUrl: settings.TICKETS_URL,      // "http://tickets.internal", or with a prefix: "https://api.example.com/v1"
  token: settings.TICKETS_TOKEN,      // sent as Authorization: Bearer <token>
  timeoutMs: 5_000,                   // per attempt; default 10000
  retries: 2,                         // idempotent calls only; default 0
});
```

```ts
// orders/src/routes/orders.ts
import { notFound, route, ServiceCallError, t } from "@browserlessapi/inferlo";
import { createTicket, getTicket } from "../../../tickets/src/routes/tickets.ts"; // the other service's routes
import { tickets } from "../clients.ts";

export const orderTicket = route.get("/orders/:id/ticket").handle(async (ctx) => {
  try {
    return await tickets.call(getTicket, { params: { id: ctx.params.id }, ctx }); // typed as getTicket's answer
  } catch (error) {
    if (error instanceof ServiceCallError && error.remoteStatus === 404) throw notFound();
    throw error;
  }
});

export const escalate = route.post("/orders/:id/escalate", { body: t.object({ note: t.string().max(500) }) }).handle(async (ctx) =>
  tickets.call(createTicket, { body: { title: `Order ${ctx.params.id}: ${ctx.body.note}` }, ctx }),
);
```

## Calls

`client.call(route, { params, query, body, ctx, signal, headers })`:

- **route** is a route made with `route.<method>(path, options).handle(...)`, imported from the other service (in a monorepo, or a shared package of route files). Only its method, path and types are used; its handler never runs in the caller.
- **params** fill the path's `:name` segments (URL-encoded) and are required when the path has any. **query** values are added to the query string. **body** is sent as JSON. All three are typed from the route's schemas, before defaults: optional fields and fields with `.default()` may be left out.
- **ctx** (the handler's context) forwards the request id as `X-Request-Id` and cancels the call when the caller's request is aborted or times out. The receiving service keeps an incoming request id only with `createApp({ trustProxy: true })`, so set it on services that are only reachable from your network.
- The answer is the route's JSON data, `undefined` for a 204, or the `Response` itself for routes that return one (streams, files).

## Errors, timeouts and retries

A call that does not succeed rejects with `ServiceCallError` (code IL2008, an `InferloError`):

- `remoteStatus` is the other service's HTTP status (`0` when no answer came: a timeout or a network error) and `remoteCode` its error code (`IL4001` for a missing row, for example). `details` has the method, URL, request id and number of attempts.
- Unhandled, it answers **502** with "Internal server error": the other service's message is logged, never sent to your caller. Handle the statuses you expect, as with the 404 above.
- `timeoutMs` (default 10 s) limits each attempt.
- `retries` (default 0) repeats idempotent calls (GET, PUT, DELETE) after a network error, a timeout, or a 502, 503 or 504 answer, waiting 100 ms, 200 ms, 400 ms and so on. POST and PATCH are never repeated, since the first attempt may have been applied.
- Invalid options and a missing path parameter raise IL2009.

## Testing

Pass the other app's `fetch` to call it in the same process, without a network:

```ts
import { app as ticketsApp } from "../../tickets/src/app.ts";
const tickets = serviceClient({ baseUrl: "http://tickets.test", token: "test-token", fetch: ticketsApp.fetch });
```

Events between services through message transports (NATS, RabbitMQ, Kafka) are planned as later parts of this feature.
