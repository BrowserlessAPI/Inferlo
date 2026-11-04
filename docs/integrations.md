# Use Inferlo with other frameworks

You do not have to rewrite an existing app to use Inferlo. There are two ways in, and you can use both:

- **Use the AI module on its own:** `import { createAI } from "@browserlessapi/inferlo/ai"` in any framework (see [AI, "Use it without createApp"](ai.md)).
- **Mount a whole Inferlo app** (routes, auth, validation, OpenAPI and the MCP server) under a path of your existing app, for example `/ai`. New features can live in Inferlo while the rest of the app stays where it is.

An Inferlo app is a standard `fetch(Request) => Response` handler, so frameworks built on Web requests (Hono, ElysiaJS, Bun, Deno, Workers) mount `app.fetch` directly. Frameworks built on Node.js requests (Express, Fastify, NestJS, Koa, plain `node:http`) use `toNodeHandler(app)`.

## Node.js frameworks: toNodeHandler

```ts
import { toNodeHandler } from "@browserlessapi/inferlo";
import { app as inferlo } from "./inferlo/app.ts";

const handler = toNodeHandler(inferlo, { prefix: "/ai" });
// handler(req, res, next?) works with node:http and every framework that passes Node requests and responses.
```

`toNodeHandler(app, { prefix })` returns an `async (req, res, next?) => void` handler:

- `prefix` is removed from the path before routing, so `GET /ai/tickets` matches `route.get("/tickets")`, `/ai/openapi.json` serves the OpenAPI document and `/ai/mcp` the MCP server. `/ai` itself is routed as `/`. Leave `prefix` out when the framework already strips the mount path (Express `app.use("/ai", ...)`).
- Requests outside the prefix (including look-alikes such as `/aix`) go to `next()` when there is one. Without `next`, they are routed with their full path, so they usually answer 404 with IL2001.
- Inferlo answers every request it routes, including its own 404 and 405 errors, with the same auth, validation, rate limits and error format as `app.fetch`.
- Request bodies are streamed. If a body parser already read the body (`express.json()`, `express.text()`, body-parser), Inferlo uses `req.body` instead: strings and bytes as they are, anything else as JSON (with `Content-Type: application/json`). Body size limits still apply.
- The client address (`req.socket.remoteAddress`) is used for `rateLimit: { by: "ip" }`. Behind a proxy, set `createApp({ trustProxy: true })`.
- Responses stream (AI streaming works), several `Set-Cookie` headers are kept, and a client that disconnects aborts the request's `signal`.

### node:http

```ts
import http from "node:http";
http.createServer(toNodeHandler(inferlo)).listen(3000);
```

### Express

```ts
import express from "express";
const server = express();
server.use("/ai", toNodeHandler(inferlo)); // Express strips "/ai" from req.url
server.listen(3000);
```

### Fastify

```ts
import Fastify from "fastify";
const handler = toNodeHandler(inferlo, { prefix: "/ai" });
const fastify = Fastify();
const mount = (request, reply) => {
  reply.hijack(); // Inferlo writes the response
  // Fastify has already parsed the body, so pass it on in req.body.
  return handler(Object.assign(request.raw, { body: request.body }), reply.raw);
};
fastify.all("/ai", mount);
fastify.all("/ai/*", mount);
```

### NestJS

```ts
const nest = await NestFactory.create(AppModule);
nest.use("/ai", toNodeHandler(inferlo)); // the Express adapter strips "/ai"
await nest.listen(3000);
```

## fromNodeRequest

`fromNodeRequest(req, { prefix?, signal? })` converts a Node request to a Web `Request` (method, URL with `https` for TLS sockets, headers, streamed or already parsed body) when you want to call `app.fetch` yourself:

```ts
const response = await inferlo.fetch(fromNodeRequest(req, { prefix: "/ai" }));
```

## Hono

Hono 4.0 and later. `@browserlessapi/inferlo/hono` has no dependency on Hono and never loads Inferlo's router, database or jobs code.

```ts
import { Hono } from "hono";
import { anthropic, createAI, env, t } from "@browserlessapi/inferlo/ai";
import { inferloAI, type InferloVariables } from "@browserlessapi/inferlo/hono";

const ai = createAI({ providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) }, models: { fast: "anthropic:claude-haiku-4-5" } });

const hono = new Hono<{ Variables: InferloVariables }>();
hono.use(inferloAI(ai)); // or hono.use("/chat/*", inferloAI(ai))

hono.post("/classify", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const { object } = await c.var.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
  return c.json(object);
});

hono.get("/chat", (c) => c.var.ai.stream({ model: "fast", prompt: c.req.query("q") ?? "" }).toResponse()); // server-sent events
```

`inferloAI(ai)` puts the AI client on the context as `c.var.ai` (typed with `new Hono<{ Variables: InferloVariables }>()`). Pass `createAI(...)` or an Inferlo app's `app.ai`; anything else raises IL5014. Function tools (`tool(...)`) work in `c.var.ai.generate({ tools })`; routes as tools need an Inferlo route handler (IL5009).

To mount a whole Inferlo app, use Hono's `mount`, which removes the path before calling the app:

```ts
hono.mount("/api", inferlo.fetch); // /api/tickets, /api/openapi.json, /api/mcp
```

The [with-hono example](../examples/with-hono) uses both, and CI tests it with Hono 4.0.0 and the latest Hono.

## Other web-standard frameworks

ElysiaJS (`mount`), Bun, Deno and Workers take `inferlo.fetch` directly; see [Deployment](deploy.md).

Framework-specific helpers for ElysiaJS, Fastify, NestJS, AdonisJS, Ts.ED, tRPC, Encore.ts and Express, each tested in CI against the framework's oldest supported and latest version, are on the [roadmap](../ROADMAP.md). `toNodeHandler` and `fromNodeRequest` are tested with `node:http` on Node.js and Bun.
