# Support policy

This page says which Inferlo versions get fixes, how versions are numbered, how features are deprecated and removed, and which runtimes, databases and frameworks each release supports. It applies to the npm package `@browserlessapi/inferlo` and all of its entry points (`/ai`, `/postgres`, `/testing` and the framework integrations).

## Versions

Inferlo follows [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

| Change | Before 1.0 (now) | From 1.0 |
|---|---|---|
| Bug and security fixes | patch (`0.4.1`) | patch (`1.2.1`) |
| New features, backwards compatible | minor (`0.5.0`) | minor (`1.3.0`) |
| Breaking changes | minor (`0.5.0`), always listed under "Breaking" in the [changelog](../CHANGELOG.md) | major only (`2.0.0`) |

What counts as public API, and therefore as breaking when it changes:

- everything exported from the package's entry points, and the documented behaviour of those exports;
- error codes (`ILxxxx`): a code is never reused or given another meaning, and the `code`, `status` and JSON shape of errors stay the same;
- the CLI's commands, flags and `--json` output;
- the HTTP behaviour of an app: status codes, response shapes, default headers, `/health`, `/ready`, `/openapi.json` and `/mcp`;
- files Inferlo writes and reads: migration files, `migrations/snapshot.json` and the tables `inferlo_migrations`, `inferlo_jobs` and `inferlo_rate_limits`;
- the supported versions below (dropping one is breaking, except when it reached end of life upstream).

Not public API: anything not exported or documented, the text of error messages (match on `code`), log message text (use the structured `fields`, see [Observability](observability.md)), and the exact format of `inferlo describe` without `--json`.

Releases are published to npm by CI only, with [provenance](https://docs.npmjs.com/generating-provenance-statements), and each one has a GitHub release with its changelog entries. While Inferlo is below 1.0, releases go out as often as daily when there are changes.

## Which versions get fixes

Before 1.0 only the latest minor version gets fixes. Upgrade to the latest release to get a fix; the changelog lists every breaking change with how to upgrade.

From 1.0:

| Release line | Bug fixes | Security fixes |
|---|---|---|
| Latest major (`1.x`), latest minor | Yes | Yes |
| Latest major, older minors | No, upgrade within the major (no breaking changes) | No, upgrade within the major |
| Previous major (LTS) | Critical bugs only | Yes, for 12 months after the next major is released |
| Older majors | No | No |

Each new major version keeps the previous one supported for security fixes for 12 months, so teams have a year to upgrade. A major version is released at most once a year.

## Deprecations

Public APIs are never removed or renamed without a deprecation first:

1. The old API keeps working and is marked `@deprecated` in its types (editors and AI coding tools show it), with the replacement named.
2. The changelog entry that deprecates it has a migration note: what to change, with a before and after example.
3. Where possible, using it logs one warning per process naming the replacement.
4. It is removed no earlier than the next major version (before 1.0: no earlier than the next minor version, listed under "Breaking").

Runtime, database and framework versions follow their upstream end of life instead (below).

## Supported runtimes, databases and frameworks

Every version range below is tested in CI on its oldest supported and its latest version, and every PostgreSQL major version still supported upstream is tested. A weekly CI run tests new upstream releases even when Inferlo did not change.

| Component | Supported |
|---|---|
| Node.js | 22.18 and newer (`engines` in package.json), every LTS line still maintained upstream and the current release |
| Bun | 1.3.0 and newer |
| Cloudflare Workers (`export default app`) | Compatibility date 2025-04-01 and later with `nodejs_compat`, tested in workerd through Miniflare 4.20250405.0 (the first Miniflare 4 release) and the latest Miniflare |
| Deno | 2.9.0 and newer (Deno supports only its newest minor line) |
| Other runtimes with Web APIs | Work through `app.fetch`; not tested in CI |
| PostgreSQL | Every major version still supported upstream (14 until its end of life on 2026-11-12, then 15 and newer) |
| Redis (`createApp({ redis })`) | Redis 6.2 (supported upstream until 2027-04-01) and newer, with the `redis` package 5.0.0 and newer |
| TypeScript | 5.9 and newer |
| Hono (`/hono`) | 4.0.0 and newer |
| Express (`/express`, `toNodeHandler`) | 4 (newest 4.x) and 5 |
| Fastify (`/fastify`) | 5.0.0 and newer |
| hapi (`/hapi`) | 21.1.0 and newer |
| ElysiaJS (`/elysia`), on Node.js and Bun | 1.0.0 and newer |
| NestJS (`/nestjs`) | 11.0.0 and newer |
| tRPC (`/trpc`) | 11.0.0 and newer |
| AdonisJS (`/adonisjs`) | 6.2.0 and newer (AdonisJS 7 needs Node.js 24) |
| Ts.ED (`/tsed`) | 8.0.1 and newer |
| Koa (`/koa`) | 2 (newest 2.x) and 3 |
| Encore.ts (`toNodeHandler` in a raw endpoint, `/ai` in services) | encore.dev 1.51.0 and newer |
| Next.js (`/nextjs`, App Router) | 15 (newest 15.x) and 16 |
| Nuxt, Nitro and h3 (`/h3`) | h3 1 (newest 1.x: Nitro 2, Nuxt 3 and 4) and h3 2 (Nitro 3) |
| Vercel AI SDK UI (`toResponse({ format: "ai-sdk" })` for `useChat`) | `ai` package 5.0.0 and newer (UI message stream protocol v1) |
| LangChain.js (`/langchain`: `toLangChainModel`, `toLangChainTools`) | `@langchain/core` 0.3 (newest 0.3.x) and 1.x |
| Vercel AI SDK providers (`aiSdk(provider)`) | `@ai-sdk/*` provider packages for `ai` 5 and newer (language model specifications v2, v3 and v4); tested with `@ai-sdk/openai-compatible` 1.0.0, 2 and the latest |
| Drizzle ORM (next to Inferlo on one Postgres database, `db.$pgClient()`) | `drizzle-orm` 0.44.0 and newer |
| Prisma (next to Inferlo on one Postgres database, through `@prisma/adapter-pg`) | Prisma 6 (with `engineType = "client"`) and 7 |
| TypeORM (next to Inferlo on one Postgres database) | TypeORM 0.3 (newest 0.3.x) and 1.x |
| OpenTelemetry API (`createApp({ tracing })`) | 1.3.0 and newer |
| SvelteKit (`/sveltekit`) | 2 (newest 2.x) and 3 |
| Astro (`/astro`) | 5 (newest 5.x) and newer |
| React Router, framework mode, formerly Remix (`/react-router`) | 7 (newest 7.x) and 8 |
| AWS Lambda (`/lambda`): function URLs, API Gateway HTTP API and REST API | Node.js runtimes `nodejs22.x` and `nodejs24.x` (tested through the Node.js 22 and 24 jobs) |
| Vercel Functions (`export default app`) and Netlify Functions 2.0 (`export default app.fetch`) | Vercel Node.js runtimes 22.x and 24.x, Netlify Functions on Node.js 22 and newer (tested through the Node.js 22 and 24 jobs) |
| Azure Functions (`/azure`): HTTP triggers in the Node.js programming model v4 | `@azure/functions` 4.3.0 and newer, on Node.js 22 and 24 |
| Google Cloud Run functions (`toNodeHandler` with the Functions Framework) | `@google-cloud/functions-framework` 4.0.0 and newer, on Node.js 22 and 24 |

When a version reaches end of life upstream, the next Inferlo release stops supporting it: the minimum moves forward, `engines` and these docs change, and the changelog lists it under "Breaking". When a new major version is released upstream, it is added to CI and supported as soon as it passes.

## Reporting problems

- Bugs and feature requests: [GitHub issues](https://github.com/BrowserlessAPI/Inferlo/issues). Include the Inferlo version (`inferlo --version` or `describe().inferlo`), the runtime and its version, and the error code if there is one.
- Security vulnerabilities: do not open a public issue. A private reporting process (`SECURITY.md`) is being set up; until then, contact BrowserlessAPI through the GitHub organization profile.
