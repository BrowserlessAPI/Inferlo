# Observability

Inferlo gives every request an id, can log every request, writes logs as readable text or as one JSON object per line for log collectors (Datadog, Loki, CloudWatch, Elastic, Google Cloud Logging), serves Prometheus metrics for requests, jobs and AI calls, and traces requests with OpenTelemetry.

```ts
export const app = createApp({
  routes: [tickets],
  logging: { format: "json", requests: true },
  metrics: { token: settings.METRICS_TOKEN },
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

Pass `logger` to send entries to a log library of your company or anything else (for pino and winston, use [`pinoLogger`](#pino) and [`winstonLogger`](#winston)). Each method gets the message, optional data (an error or a value) and optional `fields` with structured values such as `requestId`:

```ts
createApp({
  logger: {
    info: (message, data, fields) => log.info(message, { ...fields, data }),
    error: (message, data, fields) => log.error(message, { ...fields, error: data }),
  },
  logging: { requests: true },
});
```

Entries are redacted before they reach your logger. `format` only applies to the built-in logger, so passing it together with `logger` raises IL6019; `requests` works with both.

### Pino

Apps that log with [pino](https://getpino.io) (Fastify's and NestJS's usual logger) wrap it with `pinoLogger` from `@browserlessapi/inferlo/pino`, so Inferlo's request, error, job and readiness logs land in the same stream as the app's own:

```ts
import pino from "pino";
import { createApp } from "@browserlessapi/inferlo";
import { pinoLogger } from "@browserlessapi/inferlo/pino";

export const log = pino({ base: { service: "helpdesk" } });

export const app = createApp({
  routes: [tickets],
  logger: pinoLogger(log),
  logging: { requests: true },
});
```

```json
{"level":30,"time":1794083631004,"service":"helpdesk","requestId":"0b7f8a52-3c1e-4d0a-9a51-8f2f0e6c1d44","method":"GET","path":"/tickets","status":200,"durationMs":4.2,"msg":"GET /tickets 200 4.2ms"}
{"level":50,"time":1794083632118,"service":"helpdesk","requestId":"6d1c...","err":{"type":"Error","message":"connect ECONNREFUSED 10.0.0.5:5432","stack":"..."},"msg":"POST /tickets failed"}
```

- Each entry is written with `log.info(fields, message)` or `log.error(fields, message)`: fields such as `requestId`, `traceId` and `spanId` (with [tracing](#tracing-opentelemetry)), `method`, `path`, `status` and `durationMs` are top-level properties, an error is `err` (pino's error serializer writes its type, message, stack and cause), and other data is under `data` (for example `data.id` and `data.error` of a failed job).
- Inferlo's [secret redaction](security.md#secrets-in-logs) runs first, and pino's own options (`level`, `base`, `redact`, transports such as `pino-pretty`) still apply.
- Inside Fastify, `pinoLogger(fastify.log)` writes to Fastify's logger. In NestJS with `nestjs-pino`, pass the same pino instance you give `LoggerModule`.
- Passing a pino logger to `logger` without `pinoLogger` raises IL6053, because pino reads `(object, message)` and the request id and error would be lost. `pinoLogger` of anything that is not a logger raises IL6052.
- pino is not a dependency of Inferlo; pino 9.14 and later work (tested on 9.14.0 and the latest release).

### Winston

Apps that log with [winston](https://github.com/winstonjs/winston) (common in Express apps, and in NestJS with `nest-winston`) wrap it with `winstonLogger` from `@browserlessapi/inferlo/winston`, so Inferlo's request, error, job and readiness logs go through the app's formats and transports:

```ts
import winston from "winston";
import { createApp } from "@browserlessapi/inferlo";
import { winstonLogger } from "@browserlessapi/inferlo/winston";

export const log = winston.createLogger({
  format: winston.format.json(),
  defaultMeta: { service: "helpdesk" },
  transports: [new winston.transports.Console()],
});

export const app = createApp({
  routes: [tickets],
  logger: winstonLogger(log),
  logging: { requests: true },
});
```

```json
{"durationMs":4.2,"level":"info","message":"GET /tickets 200 4.2ms","method":"GET","path":"/tickets","requestId":"0b7f8a52-3c1e-4d0a-9a51-8f2f0e6c1d44","service":"helpdesk","status":200}
{"error":{"message":"connect ECONNREFUSED 10.0.0.5:5432","name":"Error","stack":"..."},"level":"error","message":"POST /tickets failed","requestId":"6d1c...","service":"helpdesk"}
```

- Each entry is written with `log.info(message, meta)` or `log.error(message, meta)`: fields such as `requestId`, `traceId` and `spanId` (with [tracing](#tracing-opentelemetry)), `method`, `path`, `status` and `durationMs` are top-level properties, an error is `error` as plain JSON (name, message, code, status, stack and cause, the same shape as the built-in JSON logger, because winston's `json` format writes an `Error` object as `{}`), and other data is under `data`.
- Inferlo's [secret redaction](security.md#secrets-in-logs) runs first, and winston's own options (`level`, `defaultMeta`, formats, transports and child loggers such as `log.child({ component: "api" })`) still apply.
- In NestJS with `nest-winston`, pass the logger you get from `WINSTON_MODULE_PROVIDER`, or the instance you give `WinstonModule`.
- Passing a winston logger to `logger` without `winstonLogger` raises IL6062, because winston reads `(message, meta)` and the request id and error would be lost. `winstonLogger` of anything that is not a logger raises IL6061.
- winston is not a dependency of Inferlo; winston 3.18 and later work (tested on 3.18.0 and the latest release).

`describe().logging` shows the setup (`{ format: "text" | "json" | "custom", requests }`), and `inferlo describe` prints it.

## Error tracking (Sentry)

`onError` is called with every unexpected error after it is logged: answers with a 5xx status (an exception in a handler or middleware, a database error, a failed AI call, a request timeout), failed WebSocket messages and failed job attempts. Client errors (4xx: validation, auth, not found) are not reported. The error is redacted first, like log entries, and the second argument says where it happened:

```ts
createApp({
  onError: (error, info) => tracker.report(error, info),
});
// info: { source: "request", requestId, method, path, route: "/tickets/:id", userId, tenantId, traceId, spanId }
//    or { source: "websocket", requestId, method, path, route, userId, tenantId }
//    or { source: "job", job: "sync-crm", jobId, attempt, maxAttempts, final, tenantId, traceId }
```

Fields that do not apply are left out. `final` is `true` when a job will not be tried again. A hook that throws or rejects is logged ("createApp({ onError }) failed") and never changes the answer or the job's outcome; the hook is not awaited. `onError` that is not a function raises IL6055.

For [Sentry](https://sentry.io), pass `sentryOnError(Sentry)` from `@browserlessapi/inferlo/sentry`:

```ts
import * as Sentry from "@sentry/node";
import { sentryOnError } from "@browserlessapi/inferlo/sentry";

Sentry.init({ dsn: settings.SENTRY_DSN, environment: settings.NODE_ENV });

export const app = createApp({
  routes: [tickets],
  jobs: [jobs],
  onError: sentryOnError(Sentry),
});
```

- Each error is sent with `Sentry.captureException` and the tags `inferlo.source`, `inferlo.route`, `inferlo.job`, `inferlo.final`, `request_id`, `tenant_id` and `trace_id` (when present), so issues can be searched and grouped by route, job or tenant, and a request id from a support ticket finds its error.
- `user` is `{ id }` of the signed-in user only; the email and name are never sent. The `inferlo` context holds every field of `info`.
- Secrets are redacted before Sentry sees the error (authorization headers, tokens, passwords in URLs, provider API keys and your `redact` values); Sentry's own `beforeSend` and data scrubbing still apply.
- Any Sentry SDK with `captureException(error, captureContext)` works: `@sentry/node`, `@sentry/bun`, `@sentry/deno`, `@sentry/cloudflare`, `@sentry/nextjs`. Sentry is not a dependency of Inferlo; `@sentry/node` 9 and later are tested (9.0.0 and the latest). Anything else raises IL6056.

## Metrics

`metrics: true` serves `GET /metrics` in the Prometheus text format, which Prometheus, Grafana Agent and Alloy, the OpenTelemetry Collector, Datadog and most other monitoring tools read:

```ts
// src/config.ts: METRICS_TOKEN: t.string().min(16), and "METRICS_TOKEN" in secrets
createApp({ metrics: { token: settings.METRICS_TOKEN } });
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: helpdesk
    bearer_token: "<the METRICS_TOKEN value>"
    static_configs:
      - targets: ["helpdesk:3000"]
```

Options:

- `token`: the endpoint answers `401` (IL3001) unless the request sends `Authorization: Bearer <token>`. Use a random secret of at least 16 characters from configuration. `{ token: undefined }` (an unset variable) raises IL6020 instead of making the endpoint public. Without `token` the endpoint is public, like `/health`, so only leave it out when the port is not reachable from the internet (for example a Kubernetes pod scraped inside the cluster).
- `path`: default `"/metrics"`. It cannot be the OpenAPI, MCP or health path or a `GET` route.
- `buckets`: upper bounds in seconds for the duration histograms. Default `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.

Invalid options raise IL6020. Metrics are off by default; new projects turn them on when `METRICS_TOKEN` is set. `describe().endpoints.metrics` shows the path (or `false`).

### What is measured

| Metric | Type | Labels |
|---|---|---|
| `inferlo_info` | gauge (always 1) | `app`, `version` (`createApp({ name, version })`), `inferlo` |
| `inferlo_http_requests_total` | counter | `method`, `route`, `status` |
| `inferlo_http_request_duration_seconds` | histogram | `method`, `route` |
| `inferlo_http_requests_in_flight` | gauge | |
| `inferlo_job_runs_total` | counter | `job`, `outcome` (`done`, `retried` or `failed`) |
| `inferlo_job_duration_seconds` | histogram | `job` |
| `inferlo_ai_calls_total` | counter | `requested` (the alias or model you asked for), `model` (the `provider:model` that answered), `kind` (`generate`, `stream` or `embed`) |
| `inferlo_ai_tokens_total` | counter | `requested`, `model`, `type` (`input` or `output`) |
| `inferlo_ai_cost_usd_total` | counter | `requested`, `model` (from `ai.pricing`; 0 without prices) |
| `inferlo_ai_call_duration_seconds` | histogram | `requested`, `model` |

- `route` is the route pattern (`/tickets/:id`), never the path with ids in it, so the number of series stays small. It is the OpenAPI or MCP path for those endpoints, and `unmatched` for `404` and `405` answers and responses sent by middleware without calling `next()`.
- Methods other than `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS` are counted as `OTHER`, so clients cannot create new series.
- Durations are measured until the response headers are ready, like request logs; a streamed body can take longer.
- The health endpoints and the metrics endpoint itself are not counted.
- AI metrics count every call that reports usage (the same calls as `ai.onUsage`, which still runs), whether it came from `ctx.ai` in a route, a job or `app.ai`. Calls of a separate `createAI(...)` client are not counted.
- Job metrics count attempts run by this process (`app.jobs.start()` or `app.jobs.runDue()`). Each instance has its own counters; Prometheus adds them up across instances with `sum(...)`.

Useful queries:

```
# Requests per second by route, and the share of 5xx answers
sum by (route) (rate(inferlo_http_requests_total[5m]))
sum(rate(inferlo_http_requests_total{status=~"5.."}[5m])) / sum(rate(inferlo_http_requests_total[5m]))

# 95th percentile latency by route
histogram_quantile(0.95, sum by (le, route) (rate(inferlo_http_request_duration_seconds_bucket[5m])))

# AI spend per alias in the last day, and failed jobs
sum by (requested) (increase(inferlo_ai_cost_usd_total[1d]))
sum by (job) (increase(inferlo_job_runs_total{outcome="failed"}[1h]))
```

## Tracing (OpenTelemetry)

Pass the OpenTelemetry API you already use, and every request gets a server span:

```ts
import * as otel from "@opentelemetry/api";

export const app = createApp({
  routes: [tickets],
  tracing: { api: otel },
});
```

Inferlo has no dependency on OpenTelemetry (`@opentelemetry/api` 1.3 and newer is an optional peer dependency): it uses the API you pass, so spans go wherever the OpenTelemetry SDK you start exports them (an OTLP collector, Jaeger, Grafana Tempo, Honeycomb, Datadog). Start the SDK before the app, for example `node --import ./otel.ts src/server.ts` with `@opentelemetry/sdk-node`. Without an SDK, the API's no-op tracer is used and nothing is recorded.

- **One server span per request**, named after the matched route (`GET /tickets/:id`; requests that match no route keep just the method, so names stay few), with the attributes `http.request.method`, `http.route`, `http.response.status_code`, `url.path`, `url.scheme`, `server.address`, `server.port` and `user_agent.original`. Answers with status 500 or more set the span's status to error and record the exception; 4xx answers do not. The span ends when the response headers are ready (a streamed body can take longer).
- **It continues the caller's trace**: the incoming `traceparent` header (and whatever else the propagator your SDK registers reads) becomes the span's parent, so a trace runs through every service.
- **The handler runs inside the span**: spans you start with `otel.trace.getTracer(...)` and spans from instrumentations (outgoing `fetch`, `pg`) become its children, and `otel.trace.getActiveSpan()` returns it.
- **Logs carry the trace**: every log entry Inferlo writes for the request (request logs, failed requests) gets `traceId` and `spanId` fields next to `requestId`, so your log tool links logs and traces.
- The health, readiness and metrics endpoints are not traced. The tracer is named after the app (`createApp({ name })`) with its `version`; set `tracing: { api: otel, tracerName: "billing-api" }` to change it.
- Anything else than `{ api }` with the OpenTelemetry API raises IL6030 at startup.

### AI calls

Every `ai.generate`, `ai.stream` and `ai.embed` call gets a client span under the active span (the request's, or yours), following the OpenTelemetry GenAI conventions:

| Attribute | Example |
|---|---|
| span name | `chat claude-haiku-4-5`, `embeddings text-embedding-3-small` (operation and the first model of the alias) |
| `gen_ai.operation.name` | `chat` or `embeddings` |
| `gen_ai.provider.name` | `anthropic` (the provider that answered) |
| `gen_ai.request.model`, `gen_ai.response.model` | the first model of the alias, and the model that answered (they differ after a fallback) |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | token counts of the whole call, tool steps included |
| `gen_ai.request.max_tokens`, `gen_ai.request.temperature` | when you set them |
| `inferlo.ai.model` | the alias you asked for (`fast`) |
| `inferlo.ai.cost_usd` | cost from `pricing` (0 without pricing) |
| `inferlo.ai.steps` | model calls in `generate` (more than 1 with tools or repairs) |
| `inferlo.ai.stream`, `inferlo.ai.cancelled` | `true` for streams, and when the reader stopped early |

- Prompts, answers, tool inputs and the `for` user id are never recorded.
- The span is active while `generate` runs, so routes and function tools the model calls, and their database queries, become its children. A stream's span ends when the stream does.
- A failed call (for example when every model failed) sets the error status, records the exception and sets `error.type` to the Inferlo error code (`IL5003`).
- `createAI` on its own (`@browserlessapi/inferlo/ai`, in any framework) takes the same option: `createAI({ providers, models, tracing: { api: otel } })`. In an app, `createApp({ tracing })` turns it on for `ctx.ai` and `app.ai`.
- Calls to other services with `serviceClient({ ..., tracing: { api: otel } })` get a client span per attempt and send its `traceparent`, so the receiving service's spans join the same trace. See [Tracing across services](services.md#tracing-across-services).

### Database queries

Queries made while a request or job is traced get a client span named after the operation and table (`SELECT tickets`, `INSERT audit_log`) with `db.system.name` (`postgresql`), `db.operation.name` and `db.collection.name`. Raw SQL (`db.$sql`) and Inferlo's own queries (rate limits, cache, job queue) get a span named after the statement (`UPDATE`) with the parameterised SQL in `db.query.text`. Values are never recorded. Queries outside a trace, such as startup or the worker polling for jobs, are not traced, so idle instances send no spans. If you also use the `pg` instrumentation, its spans appear as children of these.

### Jobs

A job continues the trace it was enqueued in. `ctx.jobs.enqueue(...)` in a traced request (or job) stores the trace with the job (W3C `traceparent` and `tracestate`, in the `trace` field of the job record and in the `inferlo_jobs` table with the database queue), and every attempt runs in a consumer span `process send-email` whose parent is that request's span, even when another instance runs it hours later. The span is active while the handler runs, so the job's database queries and AI calls are its children.

| Attribute | Example |
|---|---|
| `messaging.system`, `messaging.operation.type` | `inferlo`, `process` |
| `messaging.destination.name` | the job name |
| `messaging.message.id` | the job id (`app.jobs.get(id)`) |
| `inferlo.job.attempt` | 1 for the first run, 2 for the first retry |
| `inferlo.job.outcome` | `done`, `retried` or `failed` |

A failed attempt sets the error status, records the exception and sets `error.type` (the Inferlo error code, or the error's name). Jobs enqueued outside a trace, such as cron ticks or `app.jobs.enqueue` in a script, start a new trace. The database queue adds the `traceparent` and `tracestate` columns to an existing `inferlo_jobs` table by itself.

