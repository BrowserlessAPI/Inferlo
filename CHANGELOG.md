# Changelog

All notable changes are listed here. Inferlo follows [semantic versioning](https://semver.org); until 1.0, minor versions may include breaking changes, always listed under "Breaking".

## Unreleased

- `inferlo db migrate --allow-change` now also generates enum value changes: adding or removing values of a `t.enum` field, or turning a text field into an enum or back, replaces the column's CHECK constraint (`ALTER TABLE ... DROP CONSTRAINT "posts_kind_check"`, then `ADD CONSTRAINT "posts_kind_check" CHECK (...)`, with the name Postgres gave it). Without the flag these changes are refused with IL4019 (they were IL4013). If `--apply` finds rows that still use a removed value, it fails with the new code IL4021, naming the table and constraint, and nothing from that migration is kept.
- CI also tests Node.js 26, the newest LTS line.
- Docs: the framework and app AGENTS.md files now say error codes are `ILxxxx` (they still said `KRxxxx`).

## 0.3.0 - 2026-11-02

- **Breaking: Kairo is now Inferlo.** The npm package is `@browserlessapi/inferlo` (was `@browserlessapi/kairo`), the CLI is `inferlo` (was `kairo`), the GitHub repository is `BrowserlessAPI/Inferlo`, and error codes start with `IL` instead of `KR` (same numbers: KR1001 is now IL1001). `KairoError` is now `InferloError`, `KAIRO_VERSION` is `INFERLO_VERSION`, and `describe()` reports the version as `inferlo`. Environment variables for tests and the benchmark start with `INFERLO_`. To upgrade, replace the package name in imports and package.json, `kairo` with `inferlo` in scripts, and `KR` with `IL` where you match error codes.
- Existing projects keep working: `inferlo db migrate --apply` renames an existing `kairo_migrations` table to `inferlo_migrations` (history is kept), snapshots with the old `"kairo"` key are read, and the `"kairo"` section in package.json is still read for `entry` and `server`.

- Breaking: the minimum supported Bun version is now 1.3.0. Bun 1.2 releases skip or misorder `node:test` subtests, so Inferlo's test suite cannot verify them.

- CI tests every supported version at both ends: Node.js 22.18, 22, 24 and current; Bun 1.3.0 and latest; PostgreSQL 14 to 18 and latest; TypeScript 5.9 and latest. A weekly run catches new upstream releases.

- `inferlo db migrate --allow-change` generates default and required/optional changes of existing columns (`ALTER COLUMN ... SET DEFAULT`, `DROP DEFAULT`, `SET NOT NULL`, `DROP NOT NULL`). Making a column required with a fixed default first fills NULL rows with it. Without the flag these changes are refused with the new code IL4019 (they were IL4013) and nothing is written. If `--apply` hits NULL rows in a column made required, it fails with the new code IL4020, naming the table and column. Also available as `planMigration(models, snapshot, { allowChange: true })`; the plan now includes `changes`, and `--json` output has a `changes` list. IL4013 now covers type, enum value, reference and index changes.
- `migrations/snapshot.json` now describes each column as a structured object (`{ type, notNull, default?, enum?, references?, primaryKey? }`, format `"inferlo": 2`) instead of its SQL text. Snapshots written by 0.2.0 (`"inferlo": 1`) are read and upgraded automatically, and saved in the new format with the next generated migration. IL4013 now says what changed in each column (for example `change column posts.title (type varchar(120) -> varchar(200))`) and lists it in `details.columns`. Types: `MigrationSnapshot` is the new format; `MigrationSnapshotV1` (the old one) and `MigrationSnapshotColumn` are new exports, and `planMigration` accepts either format.
- `inferlo db migrate --apply` records a SHA-256 checksum of each migration file in `inferlo_migrations` and warns with the new code IL4018 when a file that was already applied has been edited since (it is not run again; pending files are still applied). `--json` output has a new `edited` list, and `applyMigrations(db, migrations, { onEdited })` reports the names. Line ending changes do not count as edits. Existing `inferlo_migrations` tables get a `checksum` column automatically, filled from the current files on the next run.
- `inferlo db migrate --allow-drop` generates drops of removed tables, columns and indexes (`DROP TABLE`, `ALTER TABLE ... DROP COLUMN`, `DROP INDEX`, never `CASCADE`), with a warning comment in the file. Without the flag, drops are refused with the new code IL4017 and nothing is written. Also available as `planMigration(models, snapshot, { allowDrop: true })`; the plan now includes `drops`, and `--json` output has a `drops` list. IL4013 now only covers column and index changes.
- Docs: Inferlo is now described as "the TypeScript backend framework with built-in AI model support", with a new "AI models built in" section in the README.

## 0.2.0 - 2026-10-30

- `inferlo db migrate [name]` writes versioned SQL migration files (`migrations/NNNN_name.sql`) for new tables, columns and indexes, tracked with `migrations/snapshot.json`; `inferlo db migrate --apply` runs pending files in transactions and records them in `inferlo_migrations`. Also available as `planMigration()` and `applyMigrations()`. Drops and column changes are refused for now (IL4013); new required columns without a default raise IL4014. New codes IL4015 and IL4016.
- The npm package is `@browserlessapi/inferlo` (import from "@browserlessapi/inferlo", "@browserlessapi/inferlo/postgres", "@browserlessapi/inferlo/testing"). `inferlo new` installs it from npm.

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
