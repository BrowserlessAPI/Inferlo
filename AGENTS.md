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
7. **Runs everywhere.** Use Web APIs (fetch, Request, Response, Web Crypto, streams). Node-only APIs only in `src/serve.ts` and `src/cli/`.
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
| PostgreSQL | oldest major still supported upstream (14 until 2026-11-12, then 15) and every major after it | `latest` |
| TypeScript | 5.9 | `latest` |
| Hono (`@browserlessapi/inferlo/hono`, examples/with-hono) | 4.0.0 | `latest` |
| Express (`@browserlessapi/inferlo/express`, examples/with-express) | 4 (newest 4.x, maintained upstream) | `latest` (5) |
| Fastify (`@browserlessapi/inferlo/fastify`, examples/with-fastify) | 5.0.0 (Fastify 4 reached end of life 2025-06-30) | `latest` |
| ElysiaJS (`@browserlessapi/inferlo/elysia`, examples/with-elysia), on Node.js and Bun | 1.0.0 | `latest` |
| NestJS (`@browserlessapi/inferlo/nestjs`, examples/with-nestjs) | 11.0.0 (oldest major with security support; 10 ended 2025-01-20) | `latest` (12) |
| tRPC (`@browserlessapi/inferlo/trpc`, examples/with-trpc) | 11.0.0 (tRPC 10 is no longer maintained) | `latest` |
| AdonisJS (`@browserlessapi/inferlo/adonisjs`, examples/with-adonisjs) | 6.2.0 (first stable 6.x; AdonisJS 6 is still maintained) | `latest` (7, on Node.js 24) |

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
INFERLO_TEST_DATABASE_URL=postgres://... npm test   # PostgreSQL adapter tests
npm run build                        # emits dist/
node scripts/build-llms.ts --check   # llms-full.txt is up to date
```

If you change docs, run `npm run llms` to regenerate `llms-full.txt`.

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
