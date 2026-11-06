# Inferlo

**The enterprise-ready TypeScript backend framework, with AI models built in.**

Inferlo is a batteries-included TypeScript backend framework for production APIs, SaaS products and enterprise services, in the same class as NestJS, Fastify and AdonisJS. It gives you routing, validation, a typed database layer with PostgreSQL and migrations, auth, rate limiting, background jobs, cron, OpenAPI and secure defaults in one package with zero runtime dependencies, running on Node.js, Bun and edge runtimes.

What sets it apart is that AI models are part of the core, not a plugin: Anthropic, OpenAI, Gemini, local models through Ollama and any OpenAI-compatible server behind one API, with fallback between models, typed structured output, streaming, tool calling, image input and per-user usage and cost tracking, plus an MCP server built from your routes.

```ts
import { model, route, t } from "@browserlessapi/inferlo";

export const Ticket = model("tickets", {
  title: t.string().min(3).max(200),
  body: t.text(),
  priority: t.enum(["low", "normal", "urgent"]).default("normal"),
  ownerId: t.ref("users"),
});

export const createTicket = route
  .post("/tickets", { body: Ticket.pick("title", "body"), tool: true })
  .handle(({ body, user, db }) => db.tickets.insert({ ...body, ownerId: user.id }));

export const triageTicket = route
  .post("/tickets/:id/triage", { params: t.object({ id: t.uuid() }), auth: "agent" })
  .handle(async ({ params, db, ai, user }) => {
    const ticket = await db.tickets.get(params.id);
    const { object } = await ai.generate({
      model: "fast",
      prompt: ticket.body,
      output: t.object({ priority: Ticket.fields.priority, summary: t.string().max(300) }),
      for: user.id,
    });
    return db.tickets.update(ticket.id, object);
  });
```

That one model definition gives you the database table, insert and update validation, TypeScript types, OpenAPI docs, an MCP tool and the AI output schema.

## AI models built in

- **Every major provider, one API.** Anthropic, OpenAI, Gemini, Ollama and any OpenAI-compatible server (DeepSeek, Qwen, Groq, OpenRouter, vLLM and more).
- **Model aliases with fallback.** Routes ask for `"fast"` or `"smart"`; if the first model is down or rate limited, Inferlo tries the next one.
- **Typed structured output.** Pass a schema and get validated, typed data back. Invalid answers are repaired automatically.
- **Tool calling.** Pass routes as `tools` and the model calls them as the current user, with the same auth and validation, or plain functions made with `tool(name, { description, input }).handle(fn)`, with validated arguments; a step limit and usage per step either way.
- **Streaming.** Send model output to the browser as it is generated with one call.
- **Images.** Send image URLs or base64 data with a prompt to any vision model.
- **Embeddings** for search and recommendations.
- **Usage, cost and budgets.** Every call is tracked per user, so you can bill customers and stop calls when their credits run out.
- **MCP server.** Mark a route `tool: true` and AI agents can call your API, with the same permissions as any other client.
- **Use it in any framework.** `import { createAI } from "@browserlessapi/inferlo/ai"` gives you the same AI module without `createApp`, for Express, Hono, Fastify, NestJS or a plain script, and `toNodeHandler(app, { prefix: "/ai" })` mounts a whole Inferlo app (routes, OpenAPI, MCP) inside Express, Fastify, NestJS or `node:http`, `hono.use(inferloAI(ai))` from `@browserlessapi/inferlo/hono` gives Hono handlers `c.var.ai`, `server.use(inferloAI(ai))` from `@browserlessapi/inferlo/express` gives Express handlers `req.ai`, and `fastify.register(inferloPlugin, { ai })` from `@browserlessapi/inferlo/fastify` gives Fastify `request.ai`, `server.register({ plugin: inferloPlugin, options: { ai } })` from `@browserlessapi/inferlo/hapi` gives hapi `request.ai` (and `options: { app }` with `routes: { prefix }` serves a whole Inferlo app), `new Elysia().use(inferloAI(ai))` from `@browserlessapi/inferlo/elysia` gives Elysia handlers `ai`, `InferloModule.forRoot({ ai })` from `@browserlessapi/inferlo/nestjs` makes the AI client injectable in NestJS, the provider from `@browserlessapi/inferlo/adonisjs` gives AdonisJS routes `ctx.ai`, `@Configuration({ imports: [inferloAI(ai)] })` from `@browserlessapi/inferlo/tsed` makes the AI client injectable in Ts.ED as `InferloAI`, `trpc.procedure.use(inferloAI(ai))` from `@browserlessapi/inferlo/trpc` gives tRPC procedures `ctx.ai` while `trpcTools(router, { caller, procedures })` lets a model call tRPC procedures as tools, `koa.use(inferloAI(ai))` and `koa.use(toKoaMiddleware(app, { prefix: "/api" }))` from `@browserlessapi/inferlo/koa` give Koa `ctx.ai` and a whole Inferlo app, `export const { GET, POST } = toNextHandlers(app, { prefix: "/api" })` from `@browserlessapi/inferlo/nextjs` serves a whole Inferlo app from a Next.js App Router route, `export default toH3Handler(app, { prefix: "/api" })` from `@browserlessapi/inferlo/h3` serves it from a Nuxt or Nitro server route (with `event.context.ai` from a Nitro plugin), `export const { GET, POST, fallback } = toSvelteKitHandlers(app, { prefix: "/api" })` from `@browserlessapi/inferlo/sveltekit` serves it from a SvelteKit rest route (with `event.locals.ai` from a handle hook), `export const { loader, action } = toReactRouterHandlers(app, { prefix: "/api" })` from `@browserlessapi/inferlo/react-router` serves it from a React Router (Remix) resource route, `export const handler = toLambdaHandler(app)` from `@browserlessapi/inferlo/lambda` runs it on AWS Lambda (function URLs and API Gateway, with response streaming), `handler: toAzureHandler(app, { prefix: "/api" })` from `@browserlessapi/inferlo/azure` runs it in an Azure Functions HTTP trigger (with streaming), `functions.http("inferlo", toNodeHandler(app))` runs it as a Google Cloud Run function, `export default app` runs it as a Cloudflare Worker or a Vercel Function and `export default app.fetch` as a Netlify Function, and an Encore.ts raw endpoint serves a whole Inferlo app with `api.raw({ expose: true, method: "*", path: "/inferlo/*rest" }, toNodeHandler(app, { prefix: "/inferlo" }))` (see [Use with other frameworks](docs/integrations.md)).
- **Background jobs for slow AI work.** Queue a typed job from a route with `ctx.jobs.enqueue(...)` and it runs after the response, with retries, from a Postgres queue shared by every instance (`inferlo worker` runs them in their own process), and schedule jobs with `cron("0 3 * * *", job)`.

## Why Inferlo

See the full [comparison with NestJS, AdonisJS, Fastify, Hono, ElysiaJS, Ts.ED, tRPC and Encore.ts](docs/comparison.md). Inferlo's AI features work inside each of those frameworks, and a whole Inferlo app mounts inside them (see [Use with other frameworks](docs/integrations.md)).

| | NestJS | Hono | AdonisJS | Express | **Inferlo** |
|---|---|---|---|---|---|
| Batteries included (DB, validation, auth) | Partial | No | Yes | No | **Yes** |
| Runs on Node, Bun, Deno and edge | No | Yes | No | No | **Yes** |
| One schema for DB, validation, API docs and AI | No | No | No | No | **Yes** |
| AI providers, fallback, structured output, streaming in core | No | No | No | No | **Yes** |
| Built-in MCP server from your routes | No | No | No | No | **Yes** |
| Token usage tracking and budgets | No | No | No | No | **Yes** |
| Private routes by default | No | No | No | No | **Yes** |
| Errors with codes, fixes and docs links | No | No | Partial | No | **Yes** |
| Zero runtime dependencies | No | Yes | No | No | **Yes** |

## Easy to build with AI coding tools

Inferlo is also designed so AI coding tools (Claude Code, Cursor, Codex, NeonCodex and others) write correct Inferlo code on the first try:

- **Familiar shapes.** Hono-style routes and Zod-style schemas: patterns models already know.
- **One way to do things.** One route API, one schema API, one query API, one AI API.
- **No hidden behaviour.** No decorators, no dependency injection, no global registration. Everything a handler needs is in its file.
- **Types catch invented code.** Misspelled fields, missing tables and wrong types fail at compile time. At runtime, unknown fields are rejected with "Did you mean ...?".
- **Errors that explain the fix.** Every error has a stable code (`IL1001`), the cause, the fix and a docs link.
- **Tools for agents.** `inferlo describe --json` returns the whole app map. `inferlo check --json` returns typecheck, load and test results as JSON. `inferlo add resource` generates correct CRUD code.
- **Docs for machines.** [`llms.txt`](llms.txt), [`llms-full.txt`](llms-full.txt), and every new project ships with `AGENTS.md` and `CLAUDE.md`.
- **Secure by default.** Routes require a signed-in user unless marked public, every query is parameterised, and every insert is validated, so AI-written code stays safe even with light review.

## Quick start

Requires Node.js 22.18+ or Bun 1.3+. TypeScript runs directly with no build step.

Every release is tested on Node.js 22.18, 22, 24, 26 and the current release; Bun 1.3.0 and latest; PostgreSQL 14, 15, 16, 17, 18 and latest; and TypeScript 5.9 and latest.

```bash
npx @browserlessapi/inferlo new my-app
cd my-app && npm install && npm run dev
```

Or add it to an existing project:

```bash
npm install @browserlessapi/inferlo
```

## Features

- **Routing:** `route.get/post/put/patch/delete`, typed path params, query coercion, CORS, middleware, body limits
- **Schemas:** `t.string()`, `t.email()`, `t.enum()`, `t.ref()`, ... with `.optional()`, `.default()`, `.pick()`, `.partial()`, JSON Schema output
- **Database:** typed tables (`db.tickets.findMany(...)`), PostgreSQL and in-memory adapters, `inferlo db push`, versioned migrations (`inferlo db migrate`), transactions, unique and foreign keys
- **Auth:** `auth.resolve(req)`, `bearer()` API keys, roles, password hashing with Web Crypto
- **AI:** Anthropic, OpenAI, Gemini, Ollama and any OpenAI-compatible server; aliases with fallback; structured output with automatic repair; streaming to SSE; embeddings; per-user usage and cost tracking; budgets
- **MCP:** routes with `tool: true` become MCP tools at `/mcp`, with the same auth as HTTP
- **OpenAPI 3.1** at `/openapi.json`
- **Testing:** `app.request(path, { json, as: user })`, `mockProvider()`, `memory()`
- **CLI:** `new`, `dev`, `describe`, `check`, `db push`, `db migrate`, `openapi`, `add resource`

## Documentation

- [Getting started](docs/getting-started.md)
- [Comparison with other frameworks](docs/comparison.md)
- [Configuration](docs/config.md)
- [Schemas](docs/schema.md)
- [Models and database](docs/database.md)
- [Routes](docs/routes.md)
- [Auth](docs/auth.md)
- [AI](docs/ai.md)
- [Modules](docs/modules.md)
- [Service-to-service calls](docs/services.md)
- [Caching](docs/caching.md)
- [Redis](docs/redis.md)
- [MCP, OpenAPI and describe](docs/mcp.md)
- [CLI](docs/cli.md)
- [Testing](docs/testing.md)
- [Use with other frameworks](docs/integrations.md)
- [Migrate from Express](docs/migrate-from-express.md)
- [Migrate from NestJS](docs/migrate-from-nestjs.md)
- [Migrate from Hono](docs/migrate-from-hono.md)
- [Migrate from Koa](docs/migrate-from-koa.md)
- [Migrate from Fastify](docs/migrate-from-fastify.md)
- [Security](docs/security.md)
- [Observability](docs/observability.md)
- [Deployment](docs/deploy.md)
- [Performance](docs/performance.md)
- [Error codes](docs/errors.md)
- [Support policy](docs/support.md)
- [Example: helpdesk with AI triage](examples/helpdesk)

## Status

Inferlo is at **v0.1**. The core API is usable and tested on Node and Bun with PostgreSQL. See [ROADMAP.md](ROADMAP.md) for what is next and [CHANGELOG.md](CHANGELOG.md) for what changed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). AI agents working on this repository: read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
