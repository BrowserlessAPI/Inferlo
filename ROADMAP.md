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
- [ ] Observability part 3: OpenTelemetry tracing for requests, database queries, jobs and AI calls (optional peer dependency, trace ids in logs)
- [ ] Permissions: role- and policy-based access control (`can("ticket.update", { user, ticket })`) usable in routes, tools and jobs, plus an audit log of who changed what
- [x] Security hardening part 1: secure response headers by default (`createApp({ secureHeaders })`, CSP, HSTS over HTTPS, nosniff, frame and referrer policies), and docs/security.md listing the secure defaults
- [x] Security hardening part 2: request timeouts (`createApp({ requestTimeoutMs })` and per-route `timeoutMs`, with an abort `signal` in the handler context passed on to AI and database calls)
- [x] Security hardening part 3: secret redaction in logs and errors (authorization headers, cookies, `config` secrets and provider API keys never appear in logged errors)
- [ ] Security hardening part 4: CSRF protection for cookie sessions (together with the cookie sessions item)
- [ ] Security hardening part 5: `SECURITY.md` with the supported versions and a vulnerability reporting process (needs the owner: enable private vulnerability reporting on GitHub or choose a contact address)
- [x] API versioning part 1: `deprecated: { since, sunset, link }` on routes sends the Deprecation (RFC 9745), Sunset (RFC 8594) and `Link rel="deprecation"` headers, and marks the route in OpenAPI, describe and MCP
- [x] API versioning part 2: `/v1` and `/v2` route groups, and an OpenAPI document per version
- [ ] Caching: `cache` with memory and Redis stores, per-route response caching and cache invalidation
- [ ] Redis support for rate limits, job queues and cache, tested on the oldest supported and latest Redis versions
- [ ] Performance: published, reproducible throughput and latency benchmarks against Fastify, Hono, Express and NestJS, and a performance regression check in CI
- [ ] Microservices: service-to-service calls with typed clients, and message transports (NATS, RabbitMQ, Kafka) for events between services
- [ ] GraphQL support generated from models and routes (optional module)
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
- [ ] Encore.ts: mount an Inferlo app as a raw endpoint, and use `@browserlessapi/inferlo/ai` inside Encore services
- [x] Express: middleware mount and `req.ai`
- [x] Migration guides part 1: from Express to Inferlo, route by route at the same URLs (docs/migrate-from-express.md, with a test of the setup it recommends)
- [x] Migration guides part 2: from NestJS to Inferlo (modules, providers, guards, pipes and DTOs)
- [ ] Migration guides part 3: from Hono to Inferlo

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
- [ ] Cookie sessions: `sessions({ secret })` auth helper with signed, HttpOnly cookies and CSRF protection for forms
- [x] Structured request logging with request ids and timing, JSON output option (done as Observability part 1)
- [ ] Deno support: run the test suite on Deno in CI (oldest supported and latest), fix anything that fails

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
- [ ] Response validation in development mode (warn when a handler returns data that does not match `response`)
- [ ] File uploads: `t.file()` for multipart bodies with size and type limits, and a storage interface (local disk and S3-compatible)
- [ ] WebSockets: `route.ws(path, ...)` with the same auth as HTTP routes
- [ ] Email: `mail({ smtp })` helper with templates, used by jobs
- [ ] OAuth login helpers: GitHub and Google, built on cookie sessions
- [ ] Multi-tenancy: `tenant` scoping for models and routes, so every query is filtered by the current tenant
- [ ] OpenTelemetry tracing for requests, database queries and AI calls
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
