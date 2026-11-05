# Deployment

An Inferlo app is a standard `fetch(Request) => Response` handler, so it runs anywhere.

## Linux server (Node.js)

```bash
npm ci --omit=dev
DATABASE_URL=postgres://... npx inferlo db migrate --apply   # or inferlo db push if you do not use migrations
DATABASE_URL=postgres://... PORT=3000 node src/server.ts
```

Run it under systemd or pm2 behind Nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # needed for AI streaming responses
}
```

Behind a proxy like this, set `createApp({ trustProxy: true })` so routes with `rateLimit: { by: "ip" }` see the client's address instead of the proxy's. With more than one instance, use `rateLimit: { store: "database" }` so the counts are shared, and `jobQueue: { store: "database" }` so background jobs are too (see [jobs](jobs.md)).

## Health and readiness

Load balancers, Kubernetes and other orchestrators ask two questions: is the process alive, and can it take traffic? `createApp({ health: true })` answers both:

```ts
export const app = createApp({
  // ...
  health: {
    checks: { redis: () => redis.ping() },   // optional: your own dependencies
  },
});
```

- `GET /health` (liveness) answers `200 {"status":"ok"}` while the process can answer requests. It runs no checks, so a slow database never gets a healthy instance restarted.
- `GET /ready` (readiness) runs every check at the same time and answers `200` when all pass, `503` when any fails:

```json
{ "status": "not_ready", "checks": { "database": { "status": "ok", "durationMs": 2 }, "ai": { "status": "ok", "durationMs": 0 }, "redis": { "status": "error", "durationMs": 5000, "error": "Timed out after 5000 ms." } } }
```

Built-in checks: `database` runs `select 1` on Postgres (which also covers `rateLimit` and `jobQueue` with `store: "database"`; the memory database is always ready), and `ai` (when AI is configured) checks that every alias points to a configured provider. It does not call the models, so readiness probes cost nothing. A check passes when it returns or resolves, and fails when it throws, rejects or takes longer than `timeoutMs` (default 5000).

Both endpoints are public, send `Cache-Control: no-store` and also answer `HEAD`. Failed checks show `"Check failed."` and the real error is logged, so connection strings and hostnames never reach the response; throw `httpError(503, "Replica lag too high")` to show your own message, or set `exposeErrors: true` in development. Change the paths with `health: { path: "/livez", readyPath: "/readyz" }`. `await app.checkReady()` returns the same report in code (for example in a startup script), and `inferlo describe` lists the endpoints. Invalid options, or a route that uses the same path, raise IL6014.

Kubernetes:

```yaml
livenessProbe: { httpGet: { path: /health, port: 3000 } }
readinessProbe: { httpGet: { path: /ready, port: 3000 }, periodSeconds: 10 }
```

For dashboards and alerts, `createApp({ metrics: { token } })` serves Prometheus metrics at `GET /metrics` (requests, jobs, AI calls, tokens and cost); see [metrics](observability.md#metrics).

## Graceful shutdown

When an instance is stopped (a deploy, scaling down, a node drain), the orchestrator sends SIGTERM and waits a grace period before it kills the process. `app.close()` uses that time so no request or job is cut off:

```ts
// src/server.ts (new projects do this)
const server = await app.listen(settings.PORT);
app.jobs.start();
process.on("SIGTERM", () => void app.close({ delayMs: 5000 }));
```

In order:

1. `app.closing` becomes `true` and `GET /ready` answers `503` with `{ "status": "not_ready", "checks": { "shutdown": { "status": "error", "durationMs": 0, "error": "The app is shutting down." } } }`, so load balancers stop sending traffic. `GET /health` keeps answering `200`, so the instance is not restarted.
2. For `delayMs` (default 0) requests are still served. Set it a little longer than the readiness probe period plus the time your load balancer needs to remove the instance (5 to 10 seconds is common on Kubernetes).
3. New requests then get `503` with code IL2006 and `Connection: close`, so clients and proxies retry on another instance.
4. In-flight requests, `ctx.waitUntil` tasks and the job workers started with `app.jobs.start()` (with their running job) finish, for at most `timeoutMs` (default 10000). If they take longer, `app.close()` logs what was still running and goes on.
5. Servers started with `app.listen()` close (open connections are closed when the time is up), then the database.

Calling `app.close()` again returns the same promise. Keep `delayMs + timeoutMs` below the orchestrator's grace period (30 seconds on Kubernetes by default). A request counts as in flight until its handler returns; a streamed response that is still sending when the time is up is cut off when the server closes. Invalid options raise IL6015. `inferlo worker` shuts down the same way for jobs: it stops taking jobs on SIGTERM and waits for the running one.

## Bun

```bash
bun src/server.ts
```

`app.listen()` uses `Bun.serve` automatically.

## Deno

```ts
Deno.serve(app.fetch);
```

## Cloudflare Workers and other edge runtimes

```ts
import { app } from "./app.ts";
export default app;   // app.fetch is the Worker handler
```

Use a Postgres driver that supports your edge runtime, or `memory()` for stateless services.

## AWS Lambda

```ts
import { toLambdaHandler } from "@browserlessapi/inferlo/lambda";
import { app } from "./app.ts";

export const handler = toLambdaHandler(app);                       // function URLs and API Gateway
// export const handler = toLambdaHandler(app, { streaming: true }); // function URLs with response streaming
```

See [AWS Lambda](integrations.md#aws-lambda) for event formats, cookies, binary bodies and streaming AI answers.

## Azure Functions

```ts
// src/functions/inferlo.ts
import { app as azure } from "@azure/functions";
import { toAzureHandler } from "@browserlessapi/inferlo/azure";
import { app } from "../app.ts";

azure.setup({ enableHttpStream: true });
azure.http("inferlo", {
  route: "{*path}",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  authLevel: "anonymous",
  handler: toAzureHandler(app, { prefix: "/api" }),
});
```

See [Azure Functions](integrations.md#azure-functions) for the route prefix, cookies, client addresses and streaming AI answers.

## Inside another framework

To run an Inferlo app under a path of an existing Express, Fastify, NestJS or Hono app, see [Use with other frameworks](integrations.md) (`toNodeHandler(app, { prefix })`).
