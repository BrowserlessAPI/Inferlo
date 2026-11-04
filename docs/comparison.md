# Inferlo compared with other TypeScript backend frameworks

| Framework | Primary focus | Best for | Structural style |
|---|---|---|---|
| NestJS | Architecture and modules | Enterprise apps and large teams | Heavy (decorators, dependency injection) |
| AdonisJS | Full-stack productivity | Rapid MVPs and monoliths | Batteries-included MVC |
| Fastify | Speed and validation | High-throughput JSON APIs | Plugin-based |
| Hono | Edge and web standards | Serverless and edge runtimes | Minimal, Express-like |
| ElysiaJS | Bun performance and end-to-end types | Fast APIs on Bun | Chained, type-inferred |
| Ts.ED | Structured Express/Koa apps | Teams that like classes and decorators | Decorators on Express or Koa |
| tRPC | End-to-end type safety | Full-stack TypeScript monorepos | Schema-driven RPC |
| Encore.ts | Infrastructure from code | Microservices on AWS and GCP | Declarative SDK |
| **Inferlo** | **AI models built into the backend** | **AI-powered APIs and SaaS: chat, agents, tool calling, AI features billed per user** | **Batteries-included, plain functions (no decorators)** |

## What Inferlo adds

- **AI models in the core:** Anthropic, OpenAI, Gemini, Ollama and any OpenAI-compatible server behind one API, with fallback between models, typed structured output, streaming, embeddings, image input and per-user usage and cost tracking.
- **Tool calling with your own routes:** a model can call your routes as tools, with the same permissions as the signed-in user.
- **MCP server:** mark a route `tool: true` and AI agents such as Claude Code or Cursor can call your API.
- **One schema** for the database table, validation, TypeScript types, OpenAPI and AI output.
- **Batteries included:** routes, PostgreSQL, migrations, auth, rate limiting, background jobs and cron.
- **Runs on Node.js, Bun and edge runtimes,** with zero runtime dependencies.

## Choose Inferlo when

- your API calls AI models (chat, summarising, extraction, agents) and you want providers, fallback, streaming and cost tracking handled for you;
- you want AI agents to use your API through MCP or tool calling, with your existing permissions;
- you want everything (database, auth, jobs, AI) set up out of the box, without decorators.

Choose another framework when you need its specific strength, for example NestJS for a large team that already uses its module system, or Encore.ts to provision cloud infrastructure from code. Inferlo is a young project (version 0.x); check the [changelog](../CHANGELOG.md) and [roadmap](../ROADMAP.md).

## Using Inferlo with another framework

Planned (see the roadmap): use Inferlo's AI module on its own inside any of these frameworks, or mount a whole Inferlo app inside them, with a tested example for each one.
