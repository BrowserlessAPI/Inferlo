import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makeApp } from "../src/app.ts";
import { MikroORM } from "@mikro-orm/postgresql";
import { Project, Task } from "../src/entities.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
const quiet = { info() {}, error() {} };
let ctx: Awaited<ReturnType<typeof makeApp>>;
let projectId = 0;

/**
 * MikroORM's schema diff, tried again if another test file drops one of its own tables while MikroORM reads the
 * database's tables (42P01): the example tests share one test database and run at the same time.
 */
async function updateSql(orm: MikroORM): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await orm.schema.getUpdateSchemaSQL();
    } catch (error) {
      if (attempt === 5 || !/42P01|does not exist/.test(String((error as { code?: string }).code ?? "") + String(error))) throw error;
    }
  }
}

async function dropAll() {
  await ctx.pool.query("DROP TABLE IF EXISTS pm_tasks, pm_projects, task_comments");
}

before(async () => {
  if (!PG_URL) return;
  ctx = await makeApp(PG_URL, quiet);
  await dropAll();
  // The tables the existing app's MikroORM schema generator created.
  await ctx.pool.query(await ctx.orm.schema.getCreateSchemaSQL());
  await ctx.app.db.$sync();
  const em = ctx.orm.em.fork();
  const project = em.create(Project, { name: "Launch" });
  await em.flush();
  projectId = project.id;
});
after(async () => {
  if (!PG_URL) return;
  await dropAll();
  await ctx.app.close();
  await ctx.orm.close();
  await ctx.pool.end();
});

test("a task (MikroORM's table) and its comment (Inferlo) are written in one transaction", { skip }, async () => {
  const res = await ctx.app.request("/tasks", { method: "POST", headers: auth, json: { projectId, key: "LAU-1", title: "Book the venue", comment: "Two options left" } });
  assert.equal(res.status, 201);
  const { task, comment } = (await res.json()) as { task: { id: number; key: string }; comment: { taskId: number } };
  assert.equal(comment.taskId, task.id);

  const list = await ctx.app.request(`/projects/${projectId}/tasks`, { headers: auth });
  assert.deepEqual(await list.json(), { project: { id: projectId, name: "Launch" }, tasks: [{ id: task.id, key: "LAU-1", title: "Book the venue", comments: ["Two options left"] }] });
});

test("when a write fails, both roll back and the pools keep working", { skip }, async () => {
  const before = await ctx.app.db.task_comments.count();
  // Database errors from tx.$sql are Inferlo errors: a foreign key or unique violation answers 409.
  const missing = await ctx.app.request("/tasks", { method: "POST", headers: auth, json: { projectId: 999_999, key: "X-1", title: "x", comment: "x" } });
  assert.equal(missing.status, 409);
  const duplicate = await ctx.app.request("/tasks", { method: "POST", headers: auth, json: { projectId, key: "LAU-1", title: "x", comment: "x" } });
  assert.equal(duplicate.status, 409);
  assert.equal(await ctx.app.db.task_comments.count(), before);
  const em = ctx.orm.em.fork();
  assert.equal(await em.count(Task, {}), 1, "MikroORM sees only the committed task");

  for (let i = 2; i < 14; i++) {
    const ok = await ctx.app.request("/tasks", { method: "POST", headers: auth, json: { projectId, key: `LAU-${i}`, title: "ok", comment: "ok" } });
    assert.equal(ok.status, 201, "connections went back to the pool");
  }
  const project = await ctx.orm.em.fork().findOneOrFail(Project, projectId, { populate: ["tasks"] });
  assert.equal(project.tasks.count(), 13, "MikroORM reads the rows Inferlo's transaction wrote");
});

test("a missing project is 404, routes stay private and validate input", { skip }, async () => {
  assert.equal((await ctx.app.request("/projects/999999/tasks", { headers: auth })).status, 404);
  assert.equal((await ctx.app.request(`/projects/${projectId}/tasks`)).status, 401);
  assert.equal((await ctx.app.request("/tasks", { method: "POST", headers: auth, json: { projectId, key: "", title: "x", comment: "x" } })).status, 422);
});

test("MikroORM's schema generator, with skipTables, leaves Inferlo's tables alone", { skip }, async () => {
  // Without skipTables, MikroORM's schema:update and migration:create plan to drop every table that is not one of
  // its entities. The other example tests' tables may be in this database too, so only Inferlo's are checked.
  const sql = await updateSql(ctx.orm);
  for (const table of ["task_comments", "inferlo_"]) assert.ok(!sql.includes(`"${table}`), sql);
  assert.ok(!/pm_(projects|tasks)/.test(sql), "MikroORM's own tables are up to date");

  const unconfigured = await MikroORM.init({ clientUrl: PG_URL, entities: [Project, Task], pool: { min: 0, max: 1 } });
  try {
    assert.match(await updateSql(unconfigured), /drop table if exists "task_comments"/, "why skipTables is needed");
  } finally {
    await unconfigured.close();
  }
});

test("Inferlo's sync leaves MikroORM's tables alone", { skip }, async () => {
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => !s.includes('"pm_projects"') && !s.includes('"pm_tasks"')), statements.join("\n"));
});
