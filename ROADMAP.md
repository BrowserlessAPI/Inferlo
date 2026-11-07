# Roadmap

**Goal: Inferlo 1.0 by 15 December 2026.** 1.0 means: Inferlo is an enterprise-ready, general-purpose backend framework at the level of NestJS and Fastify, with AI models built in. Every item in "Now" (enterprise readiness, integrations and core), "AI depth" and "Production essentials" is done, the API is frozen (no breaking changes after 1.0 without a major version), the docs website is live, and at least one real BrowserlessAPI service runs on Inferlo in production. Releases go out daily when there are changes, so npm always shows current progress.

The scheduled maintainer works through this list top to bottom, shipping up to four items per run, seven runs a day. Each item lands as its own tested, documented commit. Tick items when they are merged. Add new items in the right section when you discover them, and split items that are too large into numbered parts.

Priority order: AI model support is Inferlo's core promise, so the "Now" section mixes AI features with the production essentials apps need most.

## Now (highest priority)

### Enterprise readiness (top priority, alongside integrations)

Inferlo must be a production-grade, general-purpose framework at the level of NestJS and Fastify, not only an AI tool. These items come first together with the framework integrations below.

- [x] Modules: `module("billing", { models, routes, jobs, provides })` to split large apps into feature modules with explicit dependencies (no decorators, no hidden injection), shown in `inferlo describe`
- [x] Typed configuration: `config({ schema })` validated at startup from environment and `.env` files, with per-environment overrides and secrets never logged
- [x] Health and readiness part 1: `createApp({ health })` with `/health` and `/ready` endpoints checking the database (and with it the database queue and rate limits), the AI configuration and custom checks, with timeouts and no leaked error details
- [x] Health and readiness part 2: graceful shutdown, `app.close()` that makes `/ready` answer 503, stops taking new requests, waits for in-flight requests and the running job, then closes the database; the app template uses it and the built-in health endpoints
- [x] Observability part 1: request ids (`X-Request-Id`, `ctx.requestId`), request logs with timing, and JSON log output (`createApp({ logging: { format: "json", requests: true } })`)
- [x] Observability part 2: Prometheus metrics endpoint (request counts and durations by route and status, job runs, AI calls, tokens and cost per alias)
- [x] Observability part 3: OpenTelemetry tracing for requests, `createApp({ tracing: { api } })` with a server span per request that continues the caller's trace and runs the handler inside it, and trace ids in logs (optional peer dependency)
- [x] Observability part 4a: OpenTelemetry spans for AI calls (model, tokens and cost as attributes, also with `createAI({ tracing })` on its own) and database queries made inside a traced request or job
- [x] Observability part 4b: OpenTelemetry spans for jobs, with the trace carried from the request that queued them (stored with the job, also in the database queue) and cron runs as new traces
- [x] Permissions part 1: role- and policy-based access control, `permissions({ "tickets.update": ({ user, ticket }) => ... })` with `access.can(name, { user, ticket })` and `access.authorize(...)` usable in routes, tools and jobs, and the route option `permission`
- [x] Permissions part 2: audit log of who changed what (`audit` table, written from routes and jobs with the user, action, record and changes; secrets redacted)
- [x] Permissions part 3: permission names typed through `Register` (a typo in `permission: "..."` is a type error), and MCP `tools/list` leaves out tools the caller's permissions deny
- [x] Security hardening part 1: secure response headers by default (`createApp({ secureHeaders })`, CSP, HSTS over HTTPS, nosniff, frame and referrer policies), and docs/security.md listing the secure defaults
- [x] Security hardening part 2: request timeouts (`createApp({ requestTimeoutMs })` and per-route `timeoutMs`, with an abort `signal` in the handler context passed on to AI and database calls)
- [x] Security hardening part 3: secret redaction in logs and errors (authorization headers, cookies, `config` secrets and provider API keys never appear in logged errors)
- [x] Security hardening part 4: CSRF protection for cookie sessions (together with the cookie sessions item)
- [x] Access tokens from identity providers: `jwt({ issuer, audience, user })` verifies the bearer access tokens of Auth0, Okta, Entra ID, Keycloak, Clerk and any OpenID Connect provider with Web Crypto (JWKS discovery, caching and key rotation, RS/PS/ES/EdDSA and HS256 with a secret), no runtime dependency
- [x] Single sign-on part 1: OpenID Connect login for browser apps (`oidc({ issuer, clientId, clientSecret })` with the authorization code flow and PKCE, state and nonce checks), ending in a `sessions()` cookie, tested against a local OpenID provider
- [ ] Single sign-on part 2: sign-out at the provider (RP-initiated logout with `id_token_hint` and `post_logout_redirect_uri`), extra authorization parameters (`prompt`, `login_hint`, Google `hd`, Entra ID `domain_hint`), tested against oidc-provider
- [ ] Security hardening part 5: `SECURITY.md` with the supported versions and a vulnerability reporting process (needs the owner: enable private vulnerability reporting on GitHub or choose a contact address)
- [x] API versioning part 1: `deprecated: { since, sunset, link }` on routes sends the Deprecation (RFC 9745), Sunset (RFC 8594) and `Link rel="deprecation"` headers, and marks the route in OpenAPI, describe and MCP
- [x] API versioning part 2: `/v1` and `/v2` route groups, and an OpenAPI document per version
- [x] Caching part 1: `ctx.cache` and `app.cache` with `getOrSet`, `get`, `set`, `delete`, tag invalidation and required time to live, in memory or in Postgres (`createApp({ cache: { store } })`)
- [x] Caching part 2: per-route response caching, `route.get(path, { cache: { ttlMs, by: "user" | "public", tags } })` with ETags, `Cache-Control` and `Vary` headers, invalidated with `ctx.cache.invalidate(tag)`
- [x] Caching part 3: Redis cache store, `cache: { store: "redis" }` with tag invalidation (builds on Redis part 1)
- [x] Redis part 1: `createApp({ redis })` with a connected `redis` client, `rateLimit: { store: "redis" }` (one atomic script per hit) and a built-in `redis` readiness check, tested on Redis 6.2, 7.2 and latest and on the oldest supported and latest `redis` package
- [x] Redis part 2: Redis job queue, `jobQueue: { store: "redis" }`, with the same guarantees as the database queue (claimed once, retries, stuck jobs picked up again, cron ticks queued once across instances)
- [x] Performance part 1: published, reproducible throughput and latency benchmarks against Fastify, Hono, Express and NestJS (`npm run bench:perf`, docs/performance.md)
- [x] Performance part 2a: no `AbortSignal.any`, AI tool binding or audit writer per request unless the handler uses them, the client's disconnect signal kept outside the Request, and JSON answers written in one piece on Node.js (+20% throughput)
- [ ] Performance part 2b-1: an internal Node.js fast path for `app.listen()` and `toNodeHandler`: measured on 2026-11-07, building the Web `Request` and `Headers` costs about 8 us per request and the JSON `Response` with its headers about 9 us (out of about 65 us), and a lighter `Request` object breaks `new Request(req)` in user code on Node.js, so the pipeline should read method, path, headers and body from the Node.js request directly and build a Web `Request` only when a handler or middleware asks for `ctx.req`
- [ ] Performance part 2b-2: write Inferlo's own JSON answers to Node.js without a Web `Response` (status, headers including the secure headers and the body in one `writeHead`/`end`), keeping `Response` objects from handlers and middleware on the current path, with docs/performance.md and the CI floors updated
- [x] Performance part 3: a performance regression check in CI (Inferlo's throughput relative to Fastify on the same runner, so runner speed does not matter)
- [x] Microservices part 1: typed service-to-service calls with `serviceClient({ baseUrl, token, timeoutMs, retries }).call(route, { params, query, body, ctx })`, typed from the other service's route definitions, forwarding the request id and the caller's cancellation, with IL2008 errors that keep the remote status and code
- [x] Microservices part 2: W3C trace context (`traceparent`) forwarded by `serviceClient` calls when tracing is on, so a request is one trace across services, and the receiving service's spans join it
- [x] Microservices part 3a: events in one app: `event("order.paid", { payload: t.object(...) })`, jobs subscribed with `on(event, job)`, and `ctx.events.publish(...)` / `app.events.publish(...)` delivering through the job queue (retries, memory, database and Redis stores, tracing), with job ids derived from the event id so a repeated delivery is queued once
- [x] Microservices part 3b: events between services: a transport interface (`createApp({ events: { transport } })`) and a Redis Streams transport (at-least-once delivery, one consumer group per service, delivered to the same `on(event, job)` subscriptions, tested on the oldest supported and latest Redis)
- [ ] Microservices part 4: NATS, RabbitMQ and Kafka event transports as separate entry points (peer dependencies), each tested on its oldest supported and latest versions
- [ ] GraphQL support generated from models and routes (optional module)
- [x] File uploads part 1: `t.file({ maxBytes, types })` in multipart bodies (`body: t.object({ avatar: t.file(...) })`), streamed with size and type limits checked before the handler runs, documented in OpenAPI
- [x] File uploads part 2a: a storage interface (`createApp({ storage })`, `ctx.storage.put/get/delete`) with memory and local disk stores, safe keys and atomic writes
- [ ] File uploads part 2b: an S3-compatible store (AWS S3, Cloudflare R2, MinIO) with Signature V4 signing on Web Crypto (no AWS SDK dependency) and signed download URLs (`storage.url(key, { expiresIn })`), tested against MinIO on its oldest supported and latest versions
- [x] Multi-tenancy part 1: `tenant` scoping for models (`model("tickets", { ... }, { tenant: true })`) so every query, insert and update in `ctx.db` is filtered by and stamped with the current tenant from the auth result, with no way to forget the filter
- [x] Multi-tenancy part 2a: jobs (the tenant travels with the job, also through events and between services) and `inferlo describe` showing which models are tenant-scoped
- [x] Multi-tenancy part 2b: tenant-aware rate limits (`by: "tenant"`), cache keys (`cache: { by: "tenant" }`) and audit entries (the tenant recorded with each entry)
- [x] WebSockets part 1: `route.ws(path, { auth, message: schema }).handle(...)` with the same auth, validation and rate limits as HTTP routes, on Node.js, Bun and Deno
- [x] WebSockets part 2a: streaming AI answers over a socket, `socket.stream(ai.stream(...))`
- [x] WebSockets part 2b: rooms and broadcast in one process (`socket.join(room)`, `ctx.sockets.broadcast(room, data)` in routes, WebSocket handlers and jobs, `app.sockets`), per tenant
- [x] WebSockets part 2c: broadcast across instances and from `inferlo worker` through Redis Pub/Sub (`createApp({ redis, sockets: { transport: "redis" } })`), tested on the oldest supported and latest Redis
- [x] Support policy: `docs/support.md` with semantic versioning, LTS releases after 1.0, deprecation rules and supported runtime versions

### Works with other frameworks (top priority)

Inferlo's AI features should work inside every popular TypeScript backend framework, so teams can adopt Inferlo without rewriting their app. Each integration gets a docs page and a tested example in `examples/with-<framework>`, tested in CI against the oldest supported and latest version of that framework (the version policy applies).

- [x] `@browserlessapi/inferlo/ai` part 1: the AI module as a standalone entry point (providers, aliases with fallback, structured output, streaming, embeddings, image input, usage tracking) with no dependency on `createApp`, usable in any framework
- [x] `@browserlessapi/inferlo/ai` part 2: tool calling with plain functions, `tool("getWeather", { description, input }).handle(fn)`, usable with `createAI` anywhere and with `ctx.ai` next to route tools
- [x] `toNodeHandler(app)` and `fromNodeRequest(req)`: mount a whole Inferlo app (routes, MCP server, OpenAPI) inside Node frameworks under a path prefix
- [x] Hono: `app.mount("/ai", inferlo.fetch)` docs and example, plus `inferloAI()` middleware that puts `c.var.ai` on the context
- [x] ElysiaJS: `.mount("/ai", inferlo.fetch)` docs and example, plus a plugin that decorates the context with `ai`
- [x] Fastify: `inferloPlugin` (register with a prefix) and `fastify.ai` decorator
- [x] NestJS: `InferloModule.forRoot({ ai })` providing an injectable AI service, and mounting an Inferlo app with `toNodeHandler`
- [x] AdonisJS: provider that binds `ai` in the container and an example route
- [x] Ts.ED: service wrapper and Express middleware mount
- [x] tRPC: helpers to expose `ai.generate` and `ai.stream` as typed procedures, and tRPC procedures as AI tools
- [x] Encore.ts: mount an Inferlo app as a raw endpoint, and use `@browserlessapi/inferlo/ai` inside Encore services
- [x] Express: middleware mount and `req.ai`
- [x] Koa: `inferloAI()` middleware for `ctx.ai`, `toKoaMiddleware(app, { prefix, fallthrough })` and `sendResponse(ctx, response)`
- [x] Migration guides part 4: from Fastify to Inferlo (plugins, hooks, decorators, JSON schemas), with a mount that passes unmatched requests back to Fastify
- [x] Migration guides part 5: from Koa to Inferlo, route by route at the same URLs with `toKoaMiddleware(app, { fallthrough: true })`
- [x] Next.js route handlers: `export const { GET, POST } = toNextHandlers(app)` for the App Router, and `@browserlessapi/inferlo/ai` in server actions
- [x] Nuxt and Nitro (h3): mount an Inferlo app in a server route with `toH3Handler(app, { prefix })` (h3 1 and 2), and `event.context.ai` from a Nitro plugin
- [x] SvelteKit and React Router part 1: SvelteKit 2 and 3, a rest route `+server.ts` that serves an Inferlo app with `toSvelteKitHandlers(app, { prefix })`, and `event.locals.ai` from an `inferloAI(ai)` handle hook for load functions and actions
- [x] SvelteKit and React Router part 2: React Router 7 and 8 (Remix) resource routes, a splat route whose `loader` and `action` serve an Inferlo app, and `@browserlessapi/inferlo/ai` in loaders and actions
- [x] AWS Lambda: `toLambdaHandler(app)` for Lambda function URLs and API Gateway (HTTP API v2 and REST API v1 events), with response streaming for AI answers, tested against the AWS event shapes
- [x] hapi: a plugin that serves an Inferlo app under a path and decorates requests with `request.ai`, tested on the oldest supported and latest hapi
- [x] Cloudflare Workers: `export default app` tested in workerd (Miniflare) on the oldest supported and latest Workers runtime, with Worker bindings readable through `env()` and the AI module on Workers
- [x] Azure Functions and Google Cloud Run functions part 1: `toAzureHandler(app, { prefix })` for Azure Functions v4 HTTP triggers (with streaming), tested on the oldest supported and latest `@azure/functions`
- [x] Azure Functions and Google Cloud Run functions part 2: a tested `toNodeHandler(app)` setup for `@google-cloud/functions-framework` (Cloud Run functions), on the oldest supported and latest versions
- [x] Migration guides part 1: from Express to Inferlo, route by route at the same URLs (docs/migrate-from-express.md, with a test of the setup it recommends)
- [x] Migration guides part 2: from NestJS to Inferlo (modules, providers, guards, pipes and DTOs)
- [x] Migration guides part 3: from Hono to Inferlo
- [x] Vercel AI SDK UI: `ai.stream(...).toResponse({ format: "ai-sdk" })` speaks the AI SDK UI message stream protocol, so `useChat` from `@ai-sdk/react` talks to an Inferlo route directly, tested on the oldest supported and latest `ai` package
- [x] Astro: `export const ALL = toAstroHandler(app, { prefix: "/api" })` in a catch-all endpoint (`src/pages/api/[...path].ts`) and `locals.ai` from an `inferloAI(ai)` middleware, tested on Astro 5 and the latest Astro
- [x] Vercel and Netlify Functions: `export default app` (web-standard `fetch` handler) tested with the Vercel Node.js runtime and Netlify Functions 2.0 request shapes, with streaming AI answers and the client address from their forwarded headers
- [x] Deno Deploy and Bun part 1: Bun: a `Bun.serve({ routes, fetch: app.fetch })` guide with the client address, streaming and graceful shutdown, tested on Bun 1.3.0 and latest, `app.close()` letting streamed answers from `app.listen()` finish on Bun instead of cutting them off, and AI streams kept open past Bun's `idleTimeout`
- [x] Deno Deploy and Bun part 2: Deno Deploy: a `Deno.serve(app.fetch)` guide with streaming and graceful shutdown, tested together with the Deno support item
- [x] AI SDK providers: any Vercel AI SDK provider (`@ai-sdk/*`, `LanguageModelV2` and later) usable as an Inferlo provider (`aiSdk(createOpenAI({ apiKey }))` in `createAI({ providers })`), so every provider the AI SDK supports works with aliases, fallback, usage tracking and tools, tested on the oldest supported and latest `ai` package
- [x] Drizzle and Prisma part 1: Drizzle ORM next to Inferlo on one Postgres database: one shared `pg.Pool`, Drizzle in routes and jobs, Drizzle and Inferlo writes in one transaction (`tx.$pgClient()`), migrations that leave each other's tables alone, with a guide, `examples/with-drizzle` and CI on `drizzle-orm` 0.44.0 and latest
- [x] Drizzle and Prisma part 2a: Prisma next to Inferlo on one Postgres database (Prisma 6 and 7 with `@prisma/adapter-pg` on the shared pool, the Prisma client in routes and jobs, Inferlo models and Prisma models side by side, and how transactions combine), with a guide and an example tested on the oldest supported and latest Prisma
- [x] WebSockets in other frameworks: `server.on("upgrade", toNodeUpgradeHandler(app, { prefix }))` for Express, Fastify, NestJS, Koa and `node:http` servers, and `Bun.serve({ fetch: app.fetch, websocket: bunWebSocket })`
- [x] TypeORM next to Inferlo on one Postgres database (TypeORM 0.3 and 1.x, NestJS's most used ORM): repositories in routes and jobs, one transaction through `tx.$sql`, migrations that leave each other's tables alone, `examples/with-typeorm` tested in CI
- [x] Kysely next to Inferlo on one Postgres database: one shared `pg.Pool`, Kysely in routes and jobs, Kysely and Inferlo writes in one transaction through `tx.$pgClient()`, migrations that leave each other's tables alone, `examples/with-kysely` tested in CI on `kysely` 0.28.0 and latest
- [x] Sequelize next to Inferlo on one Postgres database (Sequelize 6, common in Express apps): models in routes and jobs, one transaction through `tx.$sql`, `sync()` and migrations that leave each other's tables alone, `examples/with-sequelize` tested in CI on `sequelize` 6.36.0 and latest
- [x] Knex next to Inferlo on one Postgres database (Knex 3, common in Express and Koa apps): queries in routes and jobs, one transaction through `.connection(await tx.$pgClient())`, migrations that leave each other's tables alone, `examples/with-knex` tested in CI on `knex` 3.1.0 and latest
- [x] Better Auth: `betterAuthSession(auth)` from `@browserlessapi/inferlo/better-auth` uses Better Auth's sessions as the app's auth, `session.middleware` serves its endpoints, cross-site changes with the session cookie are refused (IL3007), `examples/with-better-auth` on one Postgres pool tested in CI on `better-auth` 1.6.0 and latest
- [x] Auth.js: `authJsSession(Auth, authConfig)` from `@browserlessapi/inferlo/authjs` uses Auth.js (`@auth/core`) sessions as the app's auth, `session.middleware` serves its endpoints, cross-site changes with the session cookie are refused (IL3007), tested in CI on `@auth/core` 0.41.0 and latest
- [x] Passport.js: an Inferlo app mounted in Express with `toNodeHandler` sees the user Passport and express-session put on `req.user`, so Express apps with Passport strategies adopt Inferlo without a second sign-in, tested on the oldest supported and latest Passport
- [ ] Drizzle and Prisma part 2b: Prisma Migrate next to `inferlo db migrate` in development (`prisma migrate dev` drift checks and Inferlo's tables, `tables.external` in prisma.config.ts), tested in CI with the Prisma schema engine on the oldest supported and latest Prisma
- [x] LangChain.js: Inferlo AI aliases as a LangChain chat model and Inferlo tools (routes and `tool()`) as LangChain tools, tested on the oldest supported and latest `@langchain/core`

### Core

- [x] Agent tool calling: `ai.generate({ tools: [createTicket, getTicket] })` lets a model call routes as tools with the current user's permissions, with a step limit and usage tracked per step
- [x] Relations part 1: `db.tickets.findMany({ include: { owner: true } })` for `t.ref` fields, typed results, one extra query per relation (no N+1)
- [x] Relations part 2: reverse (has-many) relations, `db.users.findMany({ include: { tickets: true } })` for models with a `t.ref` to this one, also one query per relation
- [x] Rate limiting: `route.post(path, { rateLimit: { max: 10, per: "minute", by: "user" | "ip" } })` with memory and Postgres stores, IL code for 429
- [x] Vision input: images (URL or base64) in `ai.generate` messages for Anthropic, OpenAI, Gemini and OpenAI-compatible providers
- [x] Background jobs part 1: `job("send-email", { input: schema }).handle(fn)`, `createApp({ jobs })`, `ctx.jobs.enqueue(...)` with validated input, retries with backoff, in-memory queue, `app.jobs.start()` and `app.jobs.runDue()`
- [x] Background jobs part 2: Postgres-backed queue (table `inferlo_jobs`, claimed with `FOR UPDATE SKIP LOCKED`) shared by every instance, chosen like the rate limit store (`{ store: "database" }`), with jobs stuck in "running" after a crash picked up again
- [x] Background jobs part 3: `inferlo worker` runs `app.jobs.start()` with graceful shutdown on SIGTERM, and the app template uses it
- [x] Cron: `cron("0 * * * *", job)` running in `inferlo worker` (and `app.jobs.start()`), queued once per tick across instances
- [x] Fix: `--json` CLI errors leave out `fix` for errors with a 500 status (for example IL8007 and IL8008 from `inferlo worker`), because `InferloError.toJSON()` hides it for server errors; the CLI should always include `fix`
- [x] Cursor pagination helper: `db.x.paginate({ where, orderBy, cursor, limit })` returning `{ items, nextCursor }`
- [x] Cookie sessions: `sessions({ secret })` auth helper with signed, HttpOnly cookies and CSRF protection for forms
- [x] Structured request logging with request ids and timing, JSON output option (done as Observability part 1)
- [x] Deno support: run the test suite on Deno in CI (oldest supported and latest), fix anything that fails

## AI depth

- [ ] Streaming with tool calls: `ai.stream({ tools })` streams text and tool-call events to the browser
- [ ] Vector search on Postgres pgvector: `t.vector(1536)` field and `db.x.search({ vector, limit })`
- [ ] RAG helper: chunk, embed and search documents in one call
- [ ] Durable agents: `agent(...)` runs as a resumable workflow with pause for human approval
- [ ] Prompt files: versioned prompts in `src/prompts/*.md` with typed variables
- [ ] Evals: `inferlo test --evals` runs prompt test cases against real models and reports pass rate and cost
- [ ] Response caching for identical AI calls (opt in, TTL)
- [ ] Native structured output for Anthropic and Gemini when available
- [ ] More providers: Mistral, Azure OpenAI, AWS Bedrock and Vertex AI adapters (OpenAI-compatible where possible)
- [ ] Guardrails: optional input and output checks (max tokens, PII redaction, blocked terms) per AI call or per alias
- [ ] Audio: speech-to-text and text-to-speech through providers that support it

## Production essentials

- [ ] `inferlo db migrate` part 4e: reference changes behind `--allow-change` (`onDelete` and target table: replace the foreign key constraint)
- [ ] `inferlo db migrate` part 5: renames of tables and columns with explicit confirmation (for example `--rename notes.color=notes.colour`), so a rename is never generated as a drop plus an add
- [x] Response validation in development mode (warn when a handler returns data that does not match `response`)
- [ ] Email: `mail({ smtp })` helper with templates, used by jobs
- [ ] OAuth login helpers: GitHub and Google, built on cookie sessions
- [x] OpenTelemetry tracing for requests, database queries and AI calls (observability parts 3 and 4a)
- [ ] MySQL adapter (tested on the oldest supported and latest MySQL versions)
- [ ] SQLite adapter for small apps and tests (tested on the oldest supported and latest versions)

## Developer experience for AI coding tools

- [ ] Dev MCP server: `inferlo dev --mcp` exposes describe, check, db schema, logs and test runs as MCP tools for coding agents
- [ ] `inferlo add route`, `inferlo add model`, `inferlo add test` generators
- [ ] Typed client SDK: `inferlo client --out client.ts` generates a fully typed fetch client from the app
- [ ] `llms.txt` and `AGENTS.md` generated per app from `describe()`
- [ ] Docs website with WebSite structured data (name "Inferlo", alternateName "Inferlo Framework"), matching title, og:site_name and headings; every page also served as Markdown

## Benchmark

- [ ] Expand bench/tasks to 30 tasks covering routes, auth, validation, database, AI and bug fixing
- [ ] Equivalent task set for Express, Hono and NestJS so first-try success rates can be compared fairly
- [ ] Publish results table in README (only real, reproducible numbers)

## Done

- [x] `inferlo db migrate` parts 1 to 4d: additive changes, `--allow-drop`, checksum warnings, structured snapshots, default/required, enum value and type changes behind `--allow-change`
- [x] Release workflow: publishes to npm with provenance when package.json has a new version (needs the NPM_TOKEN secret)
- [x] Publish as `@browserlessapi/inferlo` on npm and use it in `inferlo new` and the docs

## Release (needs the owner)

- [ ] Before January 2027: move publishing to npm trusted publishing (OIDC), because npm is removing direct publish from bypass-2FA tokens (needs the owner to configure it on npmjs.com)
