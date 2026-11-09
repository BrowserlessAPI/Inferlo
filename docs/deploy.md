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

Behind a proxy like this, set `createApp({ trustProxy: true })` so routes with `rateLimit: { by: "ip" }` see the client's address instead of the proxy's. With more than one instance, use `rateLimit: { store: "database" }` (or `"redis"`, see [Redis](redis.md)) so the counts are shared, and `jobQueue: { store: "database" }` (or `"redis"`) so background jobs are too (see [jobs](jobs.md)).

## Response compression

Nginx, load balancers and CDNs usually compress answers. When nothing in front of the app does, turn on Inferlo's compression:

```ts
createApp({ routes, compression: true }); // or { threshold: 2048, encodings: ["gzip"] }
```

- Answers are compressed with gzip or deflate (the Web `CompressionStream`, on Node.js, Bun, Deno and Workers), the first of `encodings` (default `["gzip", "deflate"]`) that the request's `Accept-Encoding` accepts. Without a match the answer is sent as it is. Runtimes without `CompressionStream` (Bun before 1.3.3) send every answer uncompressed, with `Vary: Accept-Encoding`.
- Only text, JSON, JavaScript, XML and SVG answers of at least `threshold` bytes (default 1024) are compressed; answers whose size is unknown, such as streams, count as large enough. Images, archives and other binary answers are left alone.
- Never compressed: Server-Sent Events (so AI streams stay live), HEAD requests, 204, 206 and 304 answers, answers that already have a `Content-Encoding`, and answers with `Cache-Control: no-transform`.
- Compressible answers get `Vary: Accept-Encoding`, so caches keep the compressed and plain versions apart, and a strong `ETag` set by a handler becomes weak (`W/"..."`) on compressed answers. Route caching (`cache: { ttlMs }`) and its 304 answers work as before.
- `describe().compression` shows the setup (`{ threshold, encodings }` or `false`). Invalid options raise IL6063.
- Off by default. Compression costs CPU on every answer; leave it to the proxy when there is one. Do not compress answers that put a secret (such as a CSRF token) next to text an attacker can choose; see [Security](security.md#defaults).

## Health and readiness

Load balancers, Kubernetes and other orchestrators ask two questions: is the process alive, and can it take traffic? `createApp({ health: true })` answers both:

```ts
export const app = createApp({
  // ...
  health: {
    checks: { search: () => search.ping() },   // optional: your own dependencies
  },
});
```

- `GET /health` (liveness) answers `200 {"status":"ok"}` while the process can answer requests. It runs no checks, so a slow database never gets a healthy instance restarted.
- `GET /ready` (readiness) runs every check at the same time and answers `200` when all pass, `503` when any fails:

```json
{ "status": "not_ready", "checks": { "database": { "status": "ok", "durationMs": 2 }, "ai": { "status": "ok", "durationMs": 0 }, "search": { "status": "error", "durationMs": 5000, "error": "Timed out after 5000 ms." } } }
```

Built-in checks: `database` runs `select 1` on Postgres (which also covers `rateLimit` and `jobQueue` with `store: "database"`; the memory database is always ready), `redis` (with `createApp({ redis })`) sends `PING` to Redis, and `ai` (when AI is configured) checks that every alias points to a configured provider. It does not call the models, so readiness probes cost nothing. A check passes when it returns or resolves, and fails when it throws, rejects or takes longer than `timeoutMs` (default 5000).

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

`app.listen()` uses `Bun.serve` automatically, with the client address from Bun's `server.requestIP()` for rate limits by IP. `app.close()` (see [graceful shutdown](#graceful-shutdown)) lets requests and streamed answers that are still running finish, then stops the server and closes its keep-alive connections; when `timeoutMs` is up, it closes the connections that are still open.

To serve Bun's own routes (static files, HTML imports of a full-stack app) from the same server, use `Bun.serve` yourself with the Inferlo app as the `fetch` handler for every other request:

```ts
// src/server.ts
import homepage from "./index.html";
import { app } from "./app.ts";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: { "/": homepage },   // Bun's routes match first
  fetch: app.fetch,            // everything else: Inferlo routes (/api/...), /health, /ready, OpenAPI and MCP
});
app.jobs.start();

process.on("SIGTERM", async () => {
  await app.close();           // /ready answers 503, new requests get 503 IL2006, waits for running handlers and jobs
  await server.stop();         // stops listening; resolves when the open connections are done
});
```

- Bun passes its server as the second argument of `fetch`, so `app.fetch` gets the client address without a wrapper. Behind a proxy, set `createApp({ trustProxy: true })` so `X-Forwarded-For` is used.
- Inferlo's routes keep their full paths here (`route.get("/api/notes", ...)`): Bun does not remove a prefix. To serve an app whose routes start at `/` under a path, mount it in a framework that does (Hono's `app.mount("/api", inferlo.fetch)`, see [integrations](integrations.md)).
- Streamed AI answers (`ai.stream(...).toResponse()`, server-sent events) are sent as they are generated. Bun closes connections that send nothing for `idleTimeout` seconds (10 by default), so `app.fetch` turns that timeout off for each server-sent events answer (with Bun's `server.timeout(request, 0)`), and a model may pause between tokens for longer. Other long, quiet streams you return yourself follow `idleTimeout`; raise it with `Bun.serve({ idleTimeout: 60, ... })` (at most 255).
- Inferlo is tested on Bun 1.3.0 and the latest Bun, including this setup (test/bun-serve.test.ts).

## Deno

```bash
deno run -A src/server.ts
```

`app.listen()` uses `Deno.serve` automatically, with the client address from Deno's `info.remoteAddr` for rate limits by IP. `app.close()` (see [graceful shutdown](#graceful-shutdown)) lets requests and streamed answers that are still running finish, then shuts the server down; when `timeoutMs` is up, it cuts off the answers that are still streaming.

To start the server yourself, pass `app.fetch` as the handler. Deno passes its handler info as the second argument, so the app gets the client address without a wrapper:

```ts
// src/server.ts
import { app } from "./app.ts";

const server = Deno.serve({ port: Number(Deno.env.get("PORT") ?? 3000) }, app.fetch);
app.jobs.start();

Deno.addSignalListener("SIGTERM", async () => {
  await app.close();           // /ready answers 503, new requests get 503 IL2006, waits for running handlers and jobs
  await server.shutdown();     // stops listening; resolves when the open answers are done
});
```

With `deno serve` (and on Deno Deploy), the module's default export is the server: an Inferlo app has the `fetch` method it needs, so export the app itself.

```ts
// src/main.ts: deno serve -A src/main.ts (add --port to choose the port)
import { app } from "./app.ts";
export default app;
```

- Packages from npm work as on Node.js: `npm:` specifiers, or a `package.json` with `node_modules` (what `inferlo new` creates; Deno reads it). Environment variables reach `config()` and `env()` through Deno's `process.env`, so run with `--allow-env` (or `-A`).
- Streamed AI answers (`ai.stream(...).toResponse()`, server-sent events) are sent as they are generated.
- `ctx.signal` aborts when the client disconnects. Deno 2.9 also aborts a request's signal after its answer was delivered (Deno's legacy behaviour; it prints a notice about it the first time a handler uses the signal), so on Deno work you hand to `ctx.waitUntil` should not depend on `ctx.signal`. Run Deno with `--unstable-no-legacy-abort` to abort it only on disconnect.
- Behind a proxy, set `createApp({ trustProxy: true })` so `X-Forwarded-For` is used.
- Inferlo is tested on Deno 2.9.0 and the latest Deno: the whole test suite and the examples run on Deno in CI with PostgreSQL and Redis, including these setups (test/deno-serve.test.ts).

## Cloudflare Workers and other edge runtimes

```ts
import { app } from "./app.ts";
export default app;   // app.fetch is the Worker handler
```

On Cloudflare Workers, set `"compatibility_flags": ["nodejs_compat"]` and a `compatibility_date` of 2025-04-01 or later in `wrangler.jsonc`, so vars and secrets reach `config()` and `env()`. Deploy with `npx wrangler deploy`. Bindings, the client address, `waitUntil` and AI on Workers are in [Cloudflare Workers](integrations.md#cloudflare-workers). Use `memory()` for stateless services; the Postgres adapter is not yet tested on Workers.

## Vercel and Netlify Functions

```ts
// Vercel: api/index.ts, with vercel.json rewriting every path to /api
import { app } from "../src/app.ts";
export default app;
```

```ts
// Netlify: netlify/functions/api.ts
import { app } from "../../src/app.ts";
export default app.fetch;
export const config = { path: "/api/*" };
```

Rate limits by IP use the address the platform sets (`X-Real-IP` on Vercel, `context.ip` on Netlify), and `ctx.waitUntil` keeps the function alive until the work settles. See [Vercel Functions](integrations.md#vercel-functions) and [Netlify Functions](integrations.md#netlify-functions).

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

## Google Cloud Run functions

```ts
// src/index.ts
import * as functions from "@google-cloud/functions-framework";
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app } from "./app.ts";

functions.http("inferlo", toNodeHandler(app));
```

Deploy with `gcloud run deploy my-api --source . --function inferlo --base-image nodejs22`. See [Google Cloud Run functions](integrations.md#google-cloud-run-functions).

## Inside another framework

To run an Inferlo app under a path of an existing Express, Fastify, NestJS or Hono app, see [Use with other frameworks](integrations.md) (`toNodeHandler(app, { prefix })`).
