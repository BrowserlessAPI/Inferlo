# Observability

Inferlo gives every request an id, can log every request, and writes logs as readable text or as one JSON object per line for log collectors (Datadog, Loki, CloudWatch, Elastic, Google Cloud Logging). Metrics and tracing are on the [roadmap](../ROADMAP.md).

```ts
export const app = createApp({
  routes: [tickets],
  logging: { format: "json", requests: true },
});
```

## Request ids

Every response has an `X-Request-Id` header, and the same id is:

- `ctx.requestId` in route handlers and `ctx.requestId` in middleware, to pass on to other services or show to users in error pages;
- the `requestId` field of every log entry Inferlo writes for the request (failed requests, `ctx.waitUntil` errors and request logs).

Ids are random UUIDs. Behind a proxy or load balancer that sends its own id, set `createApp({ trustProxy: true })` and Inferlo keeps an incoming `X-Request-Id` header (1 to 128 letters, digits and `.`, `_`, `:`, `-`) so log entries line up across services. Without `trustProxy`, incoming ids are ignored, so clients cannot write into your logs. A handler that sets its own `X-Request-Id` header keeps it.

## Request logs

`logging: { requests: true }` logs one entry per request when its response is ready:

```
[inferlo] GET /tickets 200 4.2ms (request 0b7f8a52-3c1e-4d0a-9a51-8f2f0e6c1d44)
```

The entry's fields are `requestId`, `method`, `path` (without the query string, which can hold secrets), `status` and `durationMs` (time until the response headers were ready; a streamed body can take longer). The health endpoints (`/health` and `/ready`, see [Deployment](deploy.md#health-and-readiness)) are not logged, because load balancers call them every few seconds. Request logs are off by default; new projects turn them on.

## JSON logs

`logging: { format: "json" }` makes the built-in logger write one JSON object per line, info entries to stdout and errors to stderr:

```json
{"time":"2026-11-04T18:20:31.004Z","level":"info","app":"helpdesk","msg":"GET /tickets 200 4.2ms","requestId":"0b7f8a52-3c1e-4d0a-9a51-8f2f0e6c1d44","method":"GET","path":"/tickets","status":200,"durationMs":4.2}
{"time":"2026-11-04T18:20:32.118Z","level":"error","app":"helpdesk","msg":"POST /tickets failed","requestId":"6d1c...","error":{"name":"Error","message":"connect ECONNREFUSED 10.0.0.5:5432","code":"ECONNREFUSED","stack":"..."}}
```

- `time`, `level` (`info` or `error`), `app` (`createApp({ name })`) and `msg` are always there, followed by the entry's fields.
- Errors become `error: { name, message, code, status, stack, cause }`; other data is under `data`.
- Like every log entry, JSON lines go through [secret redaction](security.md#secrets-in-logs) first: authorization headers, cookies, tokens, passwords in URLs, provider API keys and your `redact` values are replaced with `"[redacted]"`.

The default is `format: "text"`, which is easier to read in a terminal. A common setup reads the format from configuration:

```ts
// src/config.ts: LOG_FORMAT: t.enum(["text", "json"]).default("text")
createApp({ logging: { format: settings.LOG_FORMAT, requests: true } });
```

## Your own logger

Pass `logger` to send entries to pino, winston or anything else. Each method gets the message, optional data (an error or a value) and optional `fields` with structured values such as `requestId`:

```ts
import pino from "pino";

const log = pino();
createApp({
  logger: {
    info: (message, data, fields) => log.info({ ...fields, data }, message),
    error: (message, data, fields) => log.error({ ...fields, err: data }, message),
  },
  logging: { requests: true },
});
```

Entries are redacted before they reach your logger. `format` only applies to the built-in logger, so passing it together with `logger` raises IL6019; `requests` works with both.

`describe().logging` shows the setup (`{ format: "text" | "json" | "custom", requests }`), and `inferlo describe` prints it.
