# Changelog

All notable changes are listed here. Kairo follows [semantic versioning](https://semver.org); until 1.0, minor versions may include breaking changes, always listed under "Breaking".

## Unreleased

- `kairo db migrate --apply` records a SHA-256 checksum of each migration file in `kairo_migrations` and warns with the new code KR4018 when a file that was already applied has been edited since (it is not run again; pending files are still applied). `--json` output has a new `edited` list, and `applyMigrations(db, migrations, { onEdited })` reports the names. Line ending changes do not count as edits. Existing `kairo_migrations` tables get a `checksum` column automatically, filled from the current files on the next run.
- `kairo db migrate --allow-drop` generates drops of removed tables, columns and indexes (`DROP TABLE`, `ALTER TABLE ... DROP COLUMN`, `DROP INDEX`, never `CASCADE`), with a warning comment in the file. Without the flag, drops are refused with the new code KR4017 and nothing is written. Also available as `planMigration(models, snapshot, { allowDrop: true })`; the plan now includes `drops`, and `--json` output has a `drops` list. KR4013 now only covers column and index changes.
- Docs: Kairo is now described as "the TypeScript backend framework with built-in AI model support", with a new "AI models built in" section in the README.

## 0.2.0 - 2026-10-30

- `kairo db migrate [name]` writes versioned SQL migration files (`migrations/NNNN_name.sql`) for new tables, columns and indexes, tracked with `migrations/snapshot.json`; `kairo db migrate --apply` runs pending files in transactions and records them in `kairo_migrations`. Also available as `planMigration()` and `applyMigrations()`. Drops and column changes are refused for now (KR4013); new required columns without a default raise KR4014. New codes KR4015 and KR4016.
- The npm package is `@browserlessapi/kairo` (import from "@browserlessapi/kairo", "@browserlessapi/kairo/postgres", "@browserlessapi/kairo/testing"). `kairo new` installs it from npm.

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
