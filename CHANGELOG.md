# Changelog

All notable changes are listed here. Kairo follows [semantic versioning](https://semver.org); until 1.0, minor versions may include breaking changes, always listed under "Breaking".

## Unreleased

- `kairo db migrate [name]` writes versioned SQL migration files (`migrations/NNNN_name.sql`) for new tables, columns and indexes, tracked with `migrations/snapshot.json`; `kairo db migrate --apply` runs pending files in transactions and records them in `kairo_migrations`. Also available as `planMigration()` and `applyMigrations()`. Drops and column changes are refused for now (KR4013); new required columns without a default raise KR4014. New codes KR4015 and KR4016.
- The npm package is `@kairojs/core` (import from "@kairojs/core", "@kairojs/core/postgres", "@kairojs/core/testing"). `kairo new` installs it from npm.

## 0.1.0 - 2026-10-30

First release.

- Routes: `route.get/post/put/patch/delete` with typed params, query coercion, body validation, private-by-default auth, roles, CORS, middleware, body size limits, wildcard paths.
- Schemas: `t.*` builders with validation, "did you mean" hints for unknown fields and enum values, JSON Schema output.
- Models and database: `model()`, typed table clients, memory and PostgreSQL adapters, `db push`, transactions, unique and foreign keys.
- AI: Anthropic, OpenAI, Gemini, Ollama and OpenAI-compatible providers; aliases with fallback; structured output with repair; streaming to SSE; embeddings; usage, cost and budgets.
- MCP server from routes with `tool: true`; OpenAPI 3.1; `describe()` app map.
- Auth helpers: `bearer()`, `hashToken`, `createToken`, `hashPassword`, `verifyPassword`.
- CLI: `new`, `dev`, `describe`, `check`, `db push`, `openapi`, `add resource`, all with `--json`.
- Docs, error code reference, `llms.txt`, `llms-full.txt`, example helpdesk app, AI success benchmark.
