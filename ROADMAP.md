# Roadmap

The scheduled maintainer works through this list top to bottom, shipping up to three items per run. Each item lands as its own tested, documented commit. Tick items when they are merged. Add new items in the right section when you discover them, and split items that are too large into numbered parts.

Priority order: AI model support is Inferlo's core promise, so the "Now" section mixes AI features with the production essentials apps need most.

## Now (highest priority)

- [x] Agent tool calling: `ai.generate({ tools: [createTicket, getTicket] })` lets a model call routes as tools with the current user's permissions, with a step limit and usage tracked per step
- [x] Relations part 1: `db.tickets.findMany({ include: { owner: true } })` for `t.ref` fields, typed results, one extra query per relation (no N+1)
- [ ] Relations part 2: reverse (has-many) relations, `db.users.findMany({ include: { tickets: true } })` for models with a `t.ref` to this one, also one query per relation
- [x] Rate limiting: `route.post(path, { rateLimit: { max: 10, per: "minute", by: "user" | "ip" } })` with memory and Postgres stores, IL code for 429
- [ ] Vision input: images (URL or base64) in `ai.generate` messages for Anthropic, OpenAI, Gemini and OpenAI-compatible providers
- [ ] Background jobs: `job("send-email", { input: schema }).handle(fn)`, `ctx.jobs.enqueue(...)`, Postgres-backed queue with retries and `inferlo worker`
- [ ] Cron: `cron("0 * * * *", handler)` running in `inferlo worker`
- [ ] Cursor pagination helper: `db.x.paginate({ where, orderBy, cursor, limit })` returning `{ items, nextCursor }`
- [ ] Cookie sessions: `sessions({ secret })` auth helper with signed, HttpOnly cookies and CSRF protection for forms
- [ ] Structured request logging with request ids and timing, JSON output option
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
