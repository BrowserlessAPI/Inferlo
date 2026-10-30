# AGENTS.md: working on the Kairo framework itself

This file is for AI agents and contributors changing the framework in this repository. (Apps built with Kairo get their own AGENTS.md from `templates/app/AGENTS.md`.)

## Goal

Kairo is the TypeScript backend framework AI models write best. Every change must make it easier for an AI model to write correct, secure code with Kairo, or make Kairo more capable without making it harder to use. When in doubt, choose the option a model would guess correctly without reading docs.

## Design rules (do not break these)

1. **One obvious way.** Do not add a second API for something that already has one.
2. **No hidden behaviour.** No decorators, no dependency injection containers, no global registries, no import side effects.
3. **Familiar shapes.** Stay close to Hono (routes) and Zod (schemas), which models already know.
4. **Secure by default.** Routes private unless `auth: "public"`. Every database value parameterised. Every insert and update validated.
5. **Errors explain the fix.** Every new error uses `KairoError` with a new stable code (`KRxxxx`), a plain message, a `fix`, and an entry in `docs/errors.md`. Never reuse or change the meaning of an existing code.
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
  cli/main.ts      kairo CLI
templates/app/     project created by `kairo new`
examples/          example apps with tests
docs/              documentation (source for llms-full.txt)
bench/             AI success benchmark
test/              framework tests
```

## Checks (all must pass before every commit)

```bash
npm run typecheck                    # framework + examples
npm test                             # node:test, includes examples
bun test test/                       # Bun compatibility
KAIRO_TEST_DATABASE_URL=postgres://... npm test   # PostgreSQL adapter tests
npm run build                        # emits dist/
node scripts/build-llms.ts --check   # llms-full.txt is up to date
```

If you change docs, run `npm run llms` to regenerate `llms-full.txt`.

## How to make a change

1. Pick the first unchecked item in ROADMAP.md (or a bug you found). Keep each change small and complete.
2. Write or update tests first. Every feature needs tests; every bug fix needs a regression test.
3. Implement it following the design rules.
4. Update the docs page for the feature, `docs/errors.md` for new error codes, `templates/app` if the default project should use it, and `CHANGELOG.md` under "Unreleased".
5. Run every check above.
6. Tick the ROADMAP item and commit with a clear message: `feat: ...`, `fix: ...`, `docs: ...`, `test: ...`, `perf: ...`, `refactor: ...`.
