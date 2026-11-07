// An existing MikroORM app that adopts Inferlo next to it, on the same Postgres database:
// 1. MikroORM keeps its own pool; Inferlo gets a pg pool through postgres({ pool }).
// 2. Inferlo routes read MikroORM's entities with a forked EntityManager per request.
// 3. A new table as an Inferlo model (with migrations from inferlo db migrate), written in the same
//    transaction as a MikroORM table through tx.$sql.
// 4. MikroORM's schema generator skips Inferlo's tables (schemaGenerator.skipTables), so its schema:update and
//    migrations never plan to drop them.
import { MikroORM } from "@mikro-orm/postgresql";
import pg from "pg";
import { bearer, createApp, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";
import { Project, Task } from "./entities.ts";

// A new feature, built with Inferlo: comments on MikroORM's tasks.
export const TaskComment = model("task_comments", {
  taskId: t.int().index(),
  body: t.string().min(1).max(2000),
});

export async function makeApp(databaseUrl: string, logger?: { info(message: string): void; error(message: string): void }) {
  // Two pools on one database: keep their max sizes together under the server's max_connections.
  const orm = await MikroORM.init({
    clientUrl: databaseUrl,
    entities: [Project, Task],
    pool: { max: 5 },
    // MikroORM's schema generator drops every table that is not one of its entities; leave Inferlo's tables alone.
    schemaGenerator: { skipTables: [TaskComment.name, /^inferlo_/, "audit_log"] },
  });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  const projectTasks = route
    .get("/projects/:id/tasks", { params: t.object({ id: t.int() }) })
    .handle(async ({ params, db }) => {
      // One EntityManager per request: MikroORM's identity map must not be shared between requests.
      const em = orm.em.fork();
      const project = await em.findOne(Project, params.id, { populate: ["tasks"] });
      if (!project) throw notFound(`No project ${params.id}.`);
      const tasks = project.tasks.getItems();
      const ids = tasks.map((task) => task.id);
      const comments = ids.length ? await db.task_comments.findMany({ where: { taskId: { in: ids } }, orderBy: { createdAt: "asc" } }) : [];
      return {
        project: { id: project.id, name: project.name },
        tasks: tasks.map((task) => ({ id: task.id, key: task.key, title: task.title, comments: comments.filter((c) => c.taskId === task.id).map((c) => c.body) })),
      };
    });

  // A task (MikroORM's table) and its first comment (Inferlo) commit or roll back together.
  const createTask = route
    .post("/tasks", { body: t.object({ projectId: t.int(), key: t.string().min(1).max(40), title: t.string().min(1).max(200), comment: t.string().min(1).max(2000) }) })
    .handle(({ body, db, status }) =>
      db.$transaction(async (tx) => {
        const [task] = await tx.$sql("INSERT INTO pm_tasks (project_id, key, title) VALUES ($1, $2, $3) RETURNING id, key, title", [body.projectId, body.key, body.title]);
        const comment = await tx.task_comments.insert({ taskId: task!.id as number, body: body.comment });
        status(201);
        return { task, comment };
      }),
    );

  const app = createApp({
    name: "with-mikro-orm",
    models: [TaskComment],
    db: postgres({ pool }),
    routes: [{ projectTasks, createTask }],
    auth: bearer((token) => users.get(token) ?? null),
    logger,
  });
  return { app, orm, pool };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof TaskComment];
  }
}
