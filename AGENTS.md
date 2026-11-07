# AGENTS.md: working on the Inferlo framework itself

This file is for AI agents and contributors changing the framework in this repository. (Apps built with Inferlo get their own AGENTS.md from `templates/app/AGENTS.md`.)

## Goal

Inferlo is the enterprise-ready TypeScript backend framework, with AI models built in. It must be a complete, production-grade, general-purpose backend framework at the level of NestJS and Fastify (structure for large codebases, security, observability, performance, scalability, stability and long-term support), not only an AI tool. Built-in AI model support (providers, fallback, structured output, streaming, tool calling, embeddings, usage tracking, MCP) is its distinguishing strength. It is also designed so AI coding tools write correct Inferlo code easily. Every change must keep Inferlo simple and must not make it harder to use for people or for AI coding tools. When in doubt, choose the option a model would guess correctly without reading docs.

## Design rules (do not break these)

1. **One obvious way.** Do not add a second API for something that already has one.
2. **No hidden behaviour.** No decorators, no dependency injection containers, no global registries, no import side effects.
3. **Familiar shapes.** Stay close to Hono (routes) and Zod (schemas), which models already know.
4. **Secure by default.** Routes private unless `auth: "public"`. Every database value parameterised. Every insert and update validated.
5. **Errors explain the fix.** Every new error uses `InferloError` with a new stable code (`ILxxxx`), a plain message, a `fix`, and an entry in `docs/errors.md`. Never reuse or change the meaning of an existing code.
6. **Zero runtime dependencies.** `pg` stays an optional peer dependency. Do not add runtime dependencies.
7. **Runs everywhere.** Use Web APIs (fetch, Request, Response, Web Crypto, streams). Node-only APIs only in `src/serve.ts`, `src/disk-storage.ts` (loaded with a dynamic `import()` on first use) and `src/cli/`.
8. **Stable API.** Do not rename or remove public exports. Deprecate first, with a migration note in CHANGELOG.md.
9. **Erasable TypeScript only.** No enums, namespaces or parameter properties (`erasableSyntaxOnly`), so Node can run the source directly. Relative imports end in `.ts`.
10. **No emojis** in code, docs, CLI output or commit messages.

## Layout

```
src/
  index.ts         public exports (everything public is exported here)
  app.ts           createApp, request pipeline, auth enforcement, errors
  route.ts         route builder, Context type, Register interface
  schema.ts        t.* schemas, validation, JSON Schema
  model.ts         model(), Row types
  db/              table client, memory and postgres adapters
  ai/              createAI, providers (anthropic, openai, openaiCompatible, gemini, ollama, mock)
  mcp.ts           MCP server (Streamable HTTP)
  openapi.ts       OpenAPI 3.1
  describe.ts      app map
  auth.ts          bearer(), tokens, password hashing
  storage.ts       ctx.storage, memoryStorage(); disk-storage.ts: diskStorage()
  cli/main.ts      inferlo CLI
templates/app/     project created by `inferlo new`
examples/          example apps with tests
docs/              documentation (source for llms-full.txt)
bench/             AI success benchmark
test/              framework tests
```

## Supported versions (test oldest and latest)

Every runtime, database and language Inferlo supports is tested in CI at its **oldest supported version** and its **latest version**, and every PostgreSQL major version that is still supported upstream is tested. The matrix lives in `.github/workflows/ci.yml`; CI also runs weekly so new upstream releases are tested even when Inferlo did not change.

| Component | Oldest tested | Latest tested |
|---|---|---|
| Node.js | 22.18 (`engines` in package.json) and the oldest LTS line still maintained | newest LTS and `current` |
| Bun | 1.3.0 | `latest` |
| Deno (`npm run test:deno`: the whole suite with the examples; Ts.ED with `--unsafe-proto`, which Ts.ED needs on Deno) | 2.9.0 (Deno supports only its newest minor line; its LTS releases ended 2026-04-30) | `latest` |
| PostgreSQL | oldest major still supported upstream (14 until 2026-11-12, then 15) and every major after it | `latest` |
| TypeScript | 5.9 | `latest` |
| Redis (`createApp({ redis })`: rate limits, cache, job queue, events transport and WebSocket broadcasts) | Redis 6.2 (oldest version still supported upstream, until 2027-04-01; 7.2 is tested too), `redis` package 5.0.0 (node-redis 4 gets no more releases) | `latest` (server and package) |
| Hono (`@browserlessapi/inferlo/hono`, examples/with-hono) | 4.0.0 | `latest` |
| Express (`@browserlessapi/inferlo/express`, examples/with-express) | 4 (newest 4.x, maintained upstream) | `latest` (5) |
| Fastify (`@browserlessapi/inferlo/fastify`, examples/with-fastify) | 5.0.0 (Fastify 4 reached end of life 2025-06-30) | `latest` |
| hapi (`@browserlessapi/inferlo/hapi`, examples/with-hapi) | 21.1.0 (hapi 21 is the supported major; 21.1.0 is its first release with its own TypeScript types) | `latest` |
| ElysiaJS (`@browserlessapi/inferlo/elysia`, examples/with-elysia), on Node.js and Bun | 1.0.0 | `latest` |
| NestJS (`@browserlessapi/inferlo/nestjs`, examples/with-nestjs) | 11.0.0 (oldest major with security support; 10 ended 2025-01-20) | `latest` (12) |
| tRPC (`@browserlessapi/inferlo/trpc`, examples/with-trpc) | 11.0.0 (tRPC 10 is no longer maintained) | `latest` |
| AdonisJS (`@browserlessapi/inferlo/adonisjs`, examples/with-adonisjs) | 6.2.0 (first stable 6.x; AdonisJS 6 is still maintained) | `latest` (7, on Node.js 24) |
| Ts.ED (`@browserlessapi/inferlo/tsed`, examples/with-tsed) | 8.0.1 (8.0.0 cannot be imported as native ES modules; Ts.ED 7 has had no release since December 2025) | `latest` |
| Koa (`@browserlessapi/inferlo/koa`, examples/with-koa) | 2 (newest 2.x, still maintained upstream) | `latest` (3) |
| Next.js (`@browserlessapi/inferlo/nextjs`, examples/with-nextjs) | 15 (newest 15.x, still maintained upstream with backports) | `latest` (16) |
| Nuxt, Nitro and h3 (`@browserlessapi/inferlo/h3`, examples/with-nitro) | h3 1 (newest 1.x: used by Nitro 2, Nuxt 3 and Nuxt 4, and still maintained) | `latest` (2, Nitro 3) |
| SvelteKit (`@browserlessapi/inferlo/sveltekit`, examples/with-sveltekit) | 2 (newest 2.x, the line before SvelteKit 3) | `latest` (3) |
| Astro (`@browserlessapi/inferlo/astro`, examples/with-astro) | 5 (newest 5.x; endpoints, the API context and middleware are the same in Astro 5, 6 and 7, and Astro 5 is still widely deployed) | `latest` (7) |
| React Router, framework mode (`@browserlessapi/inferlo/react-router`, examples/with-react-router) | 7 (newest 7.x, still maintained upstream) | `latest` (8) |
| AWS Lambda (`@browserlessapi/inferlo/lambda`, examples/with-lambda) | Lambda runtime `nodejs22.x` (oldest Node.js runtime Lambda supports that meets `engines`), covered by the Node.js 22 jobs; event payload formats 1.0 and 2.0 | `nodejs24.x`, covered by the Node.js 24 job |
| Vercel Functions (`export default app`, examples/with-vercel) and Netlify Functions 2.0 (`export default app.fetch`, examples/with-netlify) | Vercel Node.js 22.x runtime and Netlify Node.js 22, covered by the Node.js 22 jobs; client address from `X-Real-IP` (Vercel) and `context.ip` (Netlify) | Vercel Node.js 24.x, covered by the Node.js 24 job |
| Azure Functions (`@browserlessapi/inferlo/azure`, examples/with-azure) | `@azure/functions` 4.3.0 (the v4 programming model is the supported one; 4.3.0 is its first release with HTTP streams), on the Node.js 22 and 24 jobs | `latest` |
| Google Cloud Run functions (`toNodeHandler` with `@google-cloud/functions-framework`, examples/with-cloud-run-functions) | Functions Framework 4.0.0 (3.x has had no release since March 2025), on the Node.js 22 and 24 jobs | `latest` |
| Vercel AI SDK UI (`toResponse({ format: "ai-sdk" })`, `uiChatBody`, `fromUIMessages`; test/ai-sdk-ui.test.ts) | `ai` 5.0.0 (the first release with the UI message stream protocol v1 that `useChat` speaks; ai 4 is no longer maintained) | `latest` |
| LangChain.js (`@browserlessapi/inferlo/langchain`, test/langchain.test.ts) | `@langchain/core` 0.3 (newest 0.3.x: LangChain 0.3 is in maintenance until December 2026) | `latest` (1.x, the long-term support line) |
| Standard Schema in the AI module (`ai.generate({ output })` and `tool()` input, test/ai-standard-schema.test.ts) | zod 4.2.0, arktype 2.1.28 and `@valibot/to-json-schema` 1.5.0 with valibot 1.2.0 (the first releases with Standard JSON Schema) | `latest` |
| Vercel AI SDK providers (`aiSdk(provider)`; test/ai-sdk-provider.test.ts, in the AI SDK CI job) | `@ai-sdk/openai-compatible` 1.0.0 (LanguageModelV2, the oldest specification, made for `ai` 5), and 2 (LanguageModelV3, `ai` 6) | `latest` (LanguageModelV4, `ai` 7) |
| Drizzle ORM (next to Inferlo on one Postgres database, `db.$pgClient()`; test/drizzle.test.ts, examples/with-drizzle) | `drizzle-orm` 0.44.0 (Drizzle has no long-term support releases and fixes only its newest release; 0.44.0, May 2025, starts the minor line before the current one), on PostgreSQL 14 | `latest`, on the latest PostgreSQL |
| TypeORM (next to Inferlo on one Postgres database; examples/with-typeorm) | 0.3 (newest 0.3.x: the `legacy` line, still released next to 1.x), on PostgreSQL 14 | `latest` (1), on the latest PostgreSQL |
| Kysely (next to Inferlo on one Postgres database, `db.$pgClient()`; examples/with-kysely) | `kysely` 0.28.0 (Kysely has no long-term support releases and fixes only its newest release; 0.28.0, April 2025, starts the minor line before the current one), on PostgreSQL 14 | `latest`, on the latest PostgreSQL |
| Knex (next to Inferlo on one Postgres database, `.connection(await tx.$pgClient())`; examples/with-knex) | `knex` 3.1.0 (Knex has no long-term support releases and fixes only its newest release; 3.1.0, December 2023, was the newest release for more than two years), on PostgreSQL 14 | `latest`, on the latest PostgreSQL |
| MikroORM (next to Inferlo on one Postgres database, with `schemaGenerator.skipTables`; examples/with-mikro-orm) | `@mikro-orm/postgresql` 6 (newest 6.x, still released next to 7), on PostgreSQL 14 | `latest` (7), on the latest PostgreSQL |
| postgres.js (`@browserlessapi/inferlo/postgres-js`: Inferlo's Postgres adapter on the app's postgres.js pool with `postgresJsPool(sql)`; test/db.test.ts, relations and paginate tests on both drivers, examples/with-postgres-js) | `postgres` 3 (newest 3.x, the line before 4; `reserve()` from 3.4.0 is needed), on PostgreSQL 14 | `latest` (4), on the latest PostgreSQL |
| Better Auth (`@browserlessapi/inferlo/better-auth`, examples/with-better-auth) | `better-auth` 1.6.0 (Better Auth has no long-term support releases and fixes only its newest release; 1.6.0, April 2026, starts the minor line before the current one), on PostgreSQL 14 | `latest`, on the latest PostgreSQL |
| Auth.js (`@browserlessapi/inferlo/authjs`, test/authjs.test.ts) | `@auth/core` 0.41.0 (Auth.js is maintained for security fixes on its newest minor line only; 0.41.0, October 2025, starts that line) | `latest` |
| Passport.js (`@browserlessapi/inferlo/passport`, test/passport.test.ts, also in the Express jobs on Express 4 and 5) | `passport` 0.6.0 (the first release that regenerates the session at login; Passport has a single release line and 0.7.0 is its newest release) | `latest` |
| Sequelize (next to Inferlo on one Postgres database; examples/with-sequelize) | `sequelize` 6.36.0 (Sequelize 6 is the maintained major and fixes only its newest release; 6.36.0, February 2024, starts the minor line before the current one), on PostgreSQL 14 | `latest`, on the latest PostgreSQL |
| Prisma (next to Inferlo on one Postgres database through `@prisma/adapter-pg`; examples/with-prisma) | Prisma 6 (newest 6.x, still patched upstream; `prisma-client` generator with `engineType = "client"`), on PostgreSQL 14 | `latest` (the latest `@prisma/client`, 7; the `prisma` package's own `latest` tag can be a release candidate of its next CLI), on the latest PostgreSQL |
| OpenID Connect sign-in (`oidc()`; test/oidc-provider.test.ts against oidc-provider, a certified OpenID Connect server) | `oidc-provider` 9.0.0 (the first release of its maintained major; oidc-provider fixes only its newest major) | `latest` |
| OpenTelemetry API (`createApp({ tracing: { api } })`, optional peer dependency) | 1.3.0 (the oldest the OpenTelemetry JS SDK 2.x accepts) | `latest` |
| Cloudflare Workers (`export default app`, examples/with-cloudflare-workers, test/cloudflare-workers.test.ts), in workerd through Miniflare | Miniflare 4.20250405.0 (the first Miniflare 4 release, workerd from April 2025; Miniflare 3 gets no more releases), compatibility date 2025-04-01 with `nodejs_compat` (the first date that puts bindings in the environment) | `latest` |
| Encore.ts (`toNodeHandler` in a raw endpoint and `@browserlessapi/inferlo/ai` in services, examples/with-encore) | encore.dev 1.51.0 (Encore.ts has no long-term support releases and fixes only its newest release; 1.51.0, October 2025, is about a year of releases) | `latest` |

Rules:

1. When a new major version is released (Node, Bun, PostgreSQL, TypeScript, or any database or runtime added later, such as MySQL or Deno), add it to the matrix before or together with the next change.
2. When a version reaches end of life upstream, move "oldest tested" forward, update `engines`, README, docs/getting-started.md and docs/support.md, and note it in CHANGELOG.md under "Breaking".
3. Never drop or skip a version just to make CI pass. If a version fails, fix Inferlo for it.
4. Anything new Inferlo starts supporting (a database adapter, a runtime) gets its oldest supported and latest versions in the matrix in the same change.
5. Local runs cover one version; CI covers the full matrix. A change is only done when every CI job is green.
6. Keep the table in docs/support.md (the user-facing support policy) in step with this table.

## Checks (all must pass before every commit)

```bash
npm run typecheck                    # framework + examples
npm test                             # node:test, includes examples
bun test test/                       # Bun compatibility
npm run test:deno                    # Deno compatibility (needs deno on PATH)
INFERLO_TEST_DATABASE_URL=postgres://... npm test   # PostgreSQL adapter tests
npm run build                        # emits dist/
node scripts/build-llms.ts --check   # llms-full.txt is up to date
```

If you change docs, run `npm run llms` to regenerate `llms-full.txt`.

CI also runs `npm run bench:perf:check`, which fails when Inferlo's throughput relative to Fastify drops below a floor in `bench/perf/limits.json`. When a change makes Inferlo faster, raise the floors; never lower them to let a slower change through.

## How to make a change

1. Work through ROADMAP.md from the top: up to three items per run, each as its own complete commit. Fix bugs you find first.
2. Write or update tests first. Every feature needs tests; every bug fix needs a regression test.
3. Implement it following the design rules.
4. Update the docs page for the feature, `docs/errors.md` for new error codes, `templates/app` if the default project should use it, and `CHANGELOG.md` under "Unreleased".
5. Run every check above.
6. Tick the ROADMAP item and commit with a clear message: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `perf: ...`, `refactor: ...`.

## Releases

Releases are published to npm by `.github/workflows/release.yml` when a commit on main changes `package.json` to a version that is not on npm yet. The workflow also creates the `vX.Y.Z` tag and GitHub release, so never push tags yourself. Release at most once a day, and only when the latest CI run on main is green and CHANGELOG.md has entries under "Unreleased":

1. Choose the version: before 1.0, bump the minor version (0.2.0) if anything under "Unreleased" adds features or is breaking, otherwise the patch version (0.1.1).
2. Set it in `package.json` and `src/describe.ts` (`INFERLO_VERSION`), move the "Unreleased" entries under `## X.Y.Z - YYYY-MM-DD`, leave an empty "Unreleased" heading, and run all checks.
3. Commit as `release: vX.Y.Z` and push to main. That starts the Release workflow.
4. Check that the Release workflow succeeded and `npm view @browserlessapi/inferlo version` shows the new version. If it failed for a code reason, fix it and push; the workflow retries on the next package.json change, or run it by hand with `gh workflow run release.yml`.
