# Getting started

Kairo needs Node.js 22.18 or newer (or Bun 1.2+). TypeScript runs directly, with no build step.

## Create a project

```bash
npx github:BrowserlessAPI/kairo new my-app
cd my-app
npm install
npm run dev
```

`npm run dev` starts the server on http://localhost:3000 with an in-memory database and prints a dev API key:

```bash
curl -X POST http://localhost:3000/notes \
  -H "Authorization: Bearer dev_..." \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello"}'
```

## Project layout

```
src/
  models.ts        every model and the models array
  routes/notes.ts  routes for one feature
  app.ts           createApp({ models, routes, db, auth, ai })
  server.ts        starts the HTTP server
test/notes.test.ts
AGENTS.md          rules for AI coding agents
```

## The whole framework in one file

```ts
import { createApp, model, route, t, bearer } from "kairojs";

export const User = model("users", {
  email: t.email().unique(),
  name: t.string().max(80),
});

export const Todo = model("todos", {
  title: t.string().min(1).max(200),
  done: t.boolean().default(false),
  ownerId: t.ref("users"),
});

export const models = [User, Todo] as const;

// Register once so ctx.db and ctx.user are typed in every handler.
declare module "kairojs" {
  interface Register {
    models: typeof models;
    user: { id: string };
  }
}

export const listTodos = route
  .get("/todos", { query: t.object({ done: t.boolean().optional() }) })
  .handle(({ query, user, db }) => db.todos.findMany({ where: { ownerId: user.id, done: query.done } }));

export const createTodo = route
  .post("/todos", { body: Todo.pick("title") })
  .handle(({ body, user, db }) => db.todos.insert({ ...body, ownerId: user.id }));

export const app = createApp({
  models,
  routes: [{ listTodos, createTodo }],
  // Look up the user for the token. See docs/auth.md for API keys stored as hashes.
  auth: bearer(async (token) => (token === process.env.DEMO_TOKEN ? { id: "00000000-0000-4000-8000-000000000001" } : null)),
});
```

## Next steps

- [Schemas](schema.md): `t.*` types and validation
- [Models and database](database.md)
- [Routes](routes.md)
- [Auth](auth.md)
- [AI](ai.md)
- [MCP, OpenAPI and describe](mcp.md)
- [CLI](cli.md)
- [Testing](testing.md)
- [Deployment](deploy.md)
- [Error codes](errors.md)
