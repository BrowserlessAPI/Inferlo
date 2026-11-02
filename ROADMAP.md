# Roadmap

The scheduled maintainer works through this list top to bottom. Each item should land as one small, tested, documented change. Tick items when they are merged. Add new items in the right section when you discover them.

## 0.2: Production essentials

- [x] `inferlo db migrate` part 1: generate versioned SQL migration files for additive model changes (new tables, columns, indexes) from `migrations/snapshot.json`, plus `inferlo db migrate --apply`
- [x] `inferlo db migrate` part 2: drops of tables, columns and indexes behind explicit confirmation (`--allow-drop`)
- [x] `inferlo db migrate` part 3: checksum warning when an applied migration file was edited
- [x] `inferlo db migrate` part 4a: structured column descriptions in snapshot.json (inferlo: 2) with an upgrade path for inferlo: 1 snapshots, and IL4013 saying what changed in each column
- [x] `inferlo db migrate` part 4b: generate default and required/optional changes (`SET DEFAULT`, `DROP DEFAULT`, `DROP NOT NULL`, `SET NOT NULL`) behind explicit confirmation (`--allow-change`), with an IL code when existing NULL rows would block `SET NOT NULL`
- [x] `inferlo db migrate` part 4c: enum value changes behind `--allow-change` (replacing the enum CHECK constraint), with IL4021 when rows still use a removed value
- [x] `inferlo db migrate` part 4d: type changes behind `--allow-change` (`ALTER COLUMN ... TYPE ... USING`), with an IL code when existing values do not convert
- [ ] `inferlo db migrate` part 4e: reference changes behind `--allow-change` (`onDelete` and target table: replace the foreign key constraint)
- [ ] `inferlo db migrate` part 5: renames of tables and columns with explicit confirmation (for example `--rename notes.color=notes.colour`), so a rename is never generated as a drop plus an add
- [ ] Relations: `db.tickets.findMany({ include: { owner: true } })` for `t.ref` fields, typed results, one extra query per relation (no N+1)
- [ ] Cursor pagination helper: `db.x.paginate({ where, orderBy, cursor, limit })` returning `{ items, nextCursor }`
- [ ] Rate limiting: `route.post(path, { rateLimit: { max: 10, per: "minute", by: "user" | "ip" } })` with memory and Postgres stores, IL code for 429
- [ ] Cookie sessions: `sessions({ secret })` auth helper with signed, HttpOnly cookies and CSRF protection for forms
- [ ] Background jobs: `job("send-email", { input: schema }).handle(fn)`, `ctx.jobs.enqueue(...)`, Postgres-backed queue with retries and `inferlo worker`
- [ ] Cron: `cron("0 * * * *", handler)` running in `inferlo worker`
- [ ] Structured request logging with request ids and timing, JSON output option
- [ ] Response validation in development mode (warn when a handler returns data that does not match `response`)
- [ ] Deno test run in CI

## 0.3: AI depth

- [ ] Agent tool calling: `ai.generate({ tools: [createTicket, getTicket] })` lets a model call routes as tools with the current user's permissions, with a step limit
- [ ] Durable agents: `agent(...)` runs as a resumable workflow with pause for human approval
- [ ] Vector search on Postgres pgvector: `t.vector(1536)` field and `db.x.search({ vector, limit })`
- [ ] RAG helper: chunk, embed and search documents in one call
- [ ] Prompt files: versioned prompts in `src/prompts/*.md` with typed variables
- [ ] Evals: `inferlo test --evals` runs prompt test cases against real models and reports pass rate and cost
- [ ] Response caching for identical AI calls (opt in, TTL)
- [ ] Native structured output for Anthropic and Gemini when available

## 0.4: Developer experience for AI agents

- [ ] Dev MCP server: `inferlo dev --mcp` exposes describe, check, db schema, logs and test runs as MCP tools for coding agents
- [ ] `inferlo add route`, `inferlo add model`, `inferlo add test` generators
- [ ] Typed client SDK: `inferlo client --out client.ts` generates a fully typed fetch client from the app
- [ ] `llms.txt` and `AGENTS.md` generated per app from `describe()`
- [ ] Docs website with WebSite structured data (name "Inferlo", alternateName "Inferlo Framework"), matching title, og:site_name and headings; every page also served as Markdown

## Benchmark

- [ ] Expand bench/tasks to 30 tasks covering routes, auth, validation, database, AI and bug fixing
- [ ] Equivalent task set for Express, Hono and NestJS so first-try success rates can be compared fairly
- [ ] Publish results table in README (only real, reproducible numbers)

## Release

- [x] Release workflow: tag `v*` runs every check and publishes to npm with provenance (needs the NPM_TOKEN secret)
- [x] Publish as `@browserlessapi/inferlo` on npm and use it in `inferlo new` and the docs
- [ ] Before January 2027: move publishing to npm trusted publishing (OIDC), because npm is removing direct publish from bypass-2FA tokens (needs the owner to configure it on npmjs.com)
