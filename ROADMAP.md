# Roadmap

The scheduled maintainer works through this list top to bottom. Each item should land as one small, tested, documented change. Tick items when they are merged. Add new items in the right section when you discover them.

## 0.2: Production essentials

- [x] `kairo db migrate` part 1: generate versioned SQL migration files for additive model changes (new tables, columns, indexes) from `migrations/snapshot.json`, plus `kairo db migrate --apply`
- [ ] `kairo db migrate` part 2: drops of tables, columns and indexes behind explicit confirmation (`--allow-drop`)
- [ ] `kairo db migrate` part 3: renames and column changes (type, required, default, enum values) with explicit confirmation, and a checksum warning when an applied migration file was edited
- [ ] Relations: `db.tickets.findMany({ include: { owner: true } })` for `t.ref` fields, typed results, one extra query per relation (no N+1)
- [ ] Cursor pagination helper: `db.x.paginate({ where, orderBy, cursor, limit })` returning `{ items, nextCursor }`
- [ ] Rate limiting: `route.post(path, { rateLimit: { max: 10, per: "minute", by: "user" | "ip" } })` with memory and Postgres stores, KR code for 429
- [ ] Cookie sessions: `sessions({ secret })` auth helper with signed, HttpOnly cookies and CSRF protection for forms
- [ ] Background jobs: `job("send-email", { input: schema }).handle(fn)`, `ctx.jobs.enqueue(...)`, Postgres-backed queue with retries and `kairo worker`
- [ ] Cron: `cron("0 * * * *", handler)` running in `kairo worker`
- [ ] Structured request logging with request ids and timing, JSON output option
- [ ] Response validation in development mode (warn when a handler returns data that does not match `response`)
- [ ] Deno test run in CI

## 0.3: AI depth

- [ ] Agent tool calling: `ai.generate({ tools: [createTicket, getTicket] })` lets a model call routes as tools with the current user's permissions, with a step limit
- [ ] Durable agents: `agent(...)` runs as a resumable workflow with pause for human approval
- [ ] Vector search on Postgres pgvector: `t.vector(1536)` field and `db.x.search({ vector, limit })`
- [ ] RAG helper: chunk, embed and search documents in one call
- [ ] Prompt files: versioned prompts in `src/prompts/*.md` with typed variables
- [ ] Evals: `kairo test --evals` runs prompt test cases against real models and reports pass rate and cost
- [ ] Response caching for identical AI calls (opt in, TTL)
- [ ] Native structured output for Anthropic and Gemini when available

## 0.4: Developer experience for AI agents

- [ ] Dev MCP server: `kairo dev --mcp` exposes describe, check, db schema, logs and test runs as MCP tools for coding agents
- [ ] `kairo add route`, `kairo add model`, `kairo add test` generators
- [ ] Typed client SDK: `kairo client --out client.ts` generates a fully typed fetch client from the app
- [ ] `llms.txt` and `AGENTS.md` generated per app from `describe()`
- [ ] Docs website with WebSite structured data (name "Kairo", alternateName "Kairo Framework"), matching title, og:site_name and headings; every page also served as Markdown

## Benchmark

- [ ] Expand bench/tasks to 30 tasks covering routes, auth, validation, database, AI and bug fixing
- [ ] Equivalent task set for Express, Hono and NestJS so first-try success rates can be compared fairly
- [ ] Publish results table in README (only real, reproducible numbers)

## Release

- [x] Release workflow: tag `v*` runs every check and publishes to npm with provenance (needs the NPM_TOKEN secret)
- [x] Publish as `@browserlessapi/kairo` on npm and use it in `kairo new` and the docs
- [ ] Before January 2027: move publishing to npm trusted publishing (OIDC), because npm is removing direct publish from bypass-2FA tokens (needs the owner to configure it on npmjs.com)
