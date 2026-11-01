# Inferlo

**The TypeScript backend framework with built-in AI model support.**

Inferlo is a batteries-included TypeScript backend framework with AI models built into its core. Connect Anthropic, OpenAI, Gemini, DeepSeek, Qwen, local models through Ollama or any OpenAI-compatible server, and call them from any route with one API: automatic fallback between models, typed structured output, streaming, embeddings, and per-user usage and cost tracking. Routing, validation, database, auth, OpenAPI and an MCP server come in the same package, with zero runtime dependencies.

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
- **Streaming.** Send model output to the browser as it is generated with one call.
- **Embeddings** for search and recommendations.
- **Usage, cost and budgets.** Every call is tracked per user, so you can bill customers and stop calls when their credits run out.
- **MCP server.** Mark a route `tool: true` and AI agents can call your API, with the same permissions as any other client.

## Why Inferlo

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

Every release is tested on Node.js 22.18, 22, 24 and the current release; Bun 1.3.0 and latest; PostgreSQL 14, 15, 16, 17, 18 and latest; and TypeScript 5.9 and latest.

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
- [Schemas](docs/schema.md)
- [Models and database](docs/database.md)
- [Routes](docs/routes.md)
- [Auth](docs/auth.md)
- [AI](docs/ai.md)
- [MCP, OpenAPI and describe](docs/mcp.md)
- [CLI](docs/cli.md)
- [Testing](docs/testing.md)
- [Deployment](docs/deploy.md)
- [Error codes](docs/errors.md)
- [Example: helpdesk with AI triage](examples/helpdesk)

## Status

Inferlo is at **v0.1**. The core API is usable and tested on Node and Bun with PostgreSQL. See [ROADMAP.md](ROADMAP.md) for what is next and [CHANGELOG.md](CHANGELOG.md) for what changed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). AI agents working on this repository: read [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
