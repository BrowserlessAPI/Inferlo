import { bearer, createApp, memory, model, route, t, type Adapter } from "../src/index.ts";

export const Author = model("authors", {
  name: t.string().max(80),
  email: t.email().unique(),
});

export const Post = model("posts", {
  title: t.string().min(1).max(120),
  body: t.text(),
  views: t.int().default(0),
  rating: t.number().optional(),
  published: t.boolean().default(false),
  tags: t.array(t.string()).default(() => []),
  meta: t.json<{ source?: string }>().optional(),
  kind: t.enum(["note", "article"]).default("note"),
  publishedAt: t.date().nullable().optional(),
  authorId: t.ref("authors", { onDelete: "cascade" }),
});

export const models = [Author, Post] as const;

export const ALICE = { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"] };
export const BOB = { id: "22222222-2222-4222-8222-222222222222", roles: [] as string[] };

export function makeApp(db: Adapter = memory()) {
  const routes = {
    health: route.get("/health", { auth: "public" }).handle(() => ({ ok: true })),
    whoami: route.get("/me", { auth: "public" }).handle(({ user }) => ({ user })),
    listPosts: route
      .get("/posts", { auth: "public", query: t.object({ limit: t.int().max(50).default(10), kind: t.enum(["note", "article"]).optional() }), tool: true })
      .handle(({ query, db }) => (db as any).posts.findMany({ where: { kind: query.kind }, limit: query.limit, orderBy: { createdAt: "asc" } })),
    createPost: route
      .post("/posts", { body: Post.pick("title", "body", "authorId", "kind"), tool: { description: "Create a post" } })
      .handle(async ({ body, db, status }) => {
        status(201);
        return (db as any).posts.insert(body);
      }),
    getPost: route.get("/posts/:id", { auth: "public", params: t.object({ id: t.uuid() }), tool: true }).handle(({ params, db }) => (db as any).posts.get(params.id)),
    deletePost: route.delete("/posts/:id", { auth: "admin" }).handle(async ({ params, db }) => {
      await (db as any).posts.delete(params.id);
    }),
    files: route.get("/files/*", { auth: "public" }).handle(({ params }) => ({ path: (params as Record<string, string>)["*"] })),
    boom: route.get("/boom", { auth: "public" }).handle(() => {
      throw new Error("secret internals");
    }),
  };
  return createApp({
    name: "test-app",
    models,
    routes: [routes],
    db,
    auth: bearer((token) => (token === "alice" ? ALICE : token === "bob" ? BOB : null)),
    cors: { origin: ["https://ok.example"] },
    logger: { info() {}, error() {} },
  });
}
