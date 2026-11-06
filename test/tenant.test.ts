import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bearer, createApp, createDb, InferloError, memory, model, route, sessions, t, type Adapter, type Row } from "../src/index.ts";
import { modelIndexes, postgres } from "../src/db/postgres.ts";
import { readJson } from "../src/testing.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;

// Table names unique to this file: test files run in parallel against one database.
const Member = model("tn_members", { name: t.string() });
const Project = model("tn_projects", { name: t.string().max(80), slug: t.string().unique(), ownerId: t.ref("tn_members").optional() }, { tenant: true });
const Task = model("tn_tasks", { title: t.string(), projectId: t.ref("tn_projects", { onDelete: "cascade" }) }, { tenant: true });
const models = [Member, Project, Task] as const;

const ACME = { id: "11111111-1111-4111-8111-111111111111", tenantId: "acme" };
const ACME_2 = { id: "22222222-2222-4222-8222-222222222222", tenantId: "acme" };
const GLOBEX = { id: "33333333-3333-4333-8333-333333333333", tenantId: "globex" };
const LONER = { id: "44444444-4444-4444-8444-444444444444" };

function routes() {
  // ctx.db is typed by the app's Register; this file does not register its models.
  type Db = ReturnType<typeof createDb<typeof models>>;
  const scoped = (ctx: { db: unknown }) => ctx.db as Db;
  return {
    list: route.get("/projects").handle((ctx) => scoped(ctx).tn_projects.findMany({ orderBy: { name: "asc" } })),
    create: route.post("/projects", { body: Project.pick("name", "slug") }).handle((ctx) => scoped(ctx).tn_projects.insert(ctx.body)),
    get: route.get("/projects/:id").handle((ctx) => scoped(ctx).tn_projects.get(ctx.params.id, { include: { tn_tasks: true } })),
    rename: route.patch("/projects/:id", { body: t.object({ name: t.string() }) }).handle((ctx) => scoped(ctx).tn_projects.update(ctx.params.id, ctx.body)),
    remove: route.delete("/projects/:id").handle(async (ctx) => ({ deleted: await scoped(ctx).tn_projects.delete(ctx.params.id) })),
    members: route.get("/members").handle((ctx) => scoped(ctx).tn_members.findMany()),
    open: route.get("/open", { auth: "public" }).handle((ctx) => scoped(ctx).tn_projects.count()),
  };
}

const adapters: [string, () => Adapter][] = [["memory", () => memory()]];
if (PG_URL) adapters.push(["postgres", () => postgres({ url: PG_URL })]);

for (const [name, make] of adapters) {
  describe(`tenant-scoped models (${name})`, () => {
    const adapter = make();
    const db = createDb(models, adapter);

    before(async () => {
      if (name === "postgres") await db.$sql('DROP TABLE IF EXISTS "tn_tasks", "tn_projects", "tn_members" CASCADE');
      await db.$sync();
    });
    after(async () => {
      await db.$close();
    });

    test("inserts are stamped with the tenant, and reads, counts, updates and deletes see only its rows", async () => {
      const acme = db.$tenant("acme");
      const globex = db.$tenant("globex");
      const a = await acme.tn_projects.insert({ name: "Apollo", slug: "apollo" });
      const g = await globex.tn_projects.insert({ name: "Gemini", slug: "gemini" });
      assert.equal(a.tenantId, "acme");
      assert.equal(g.tenantId, "globex");
      assert.equal(acme.$tenantId, "acme");

      assert.deepEqual((await acme.tn_projects.findMany()).map((p) => p.name), ["Apollo"]);
      assert.equal(await acme.tn_projects.find(g.id), null);
      await assert.rejects(acme.tn_projects.get(g.id), (e: InferloError) => e.code === "IL4001");
      assert.equal(await acme.tn_projects.count(), 1);
      assert.equal(await acme.tn_projects.findOne({ slug: "gemini" }), null);
      // A where on tenantId cannot widen the filter: both conditions apply.
      assert.equal((await acme.tn_projects.findMany({ where: { tenantId: "globex" } })).length, 0);
      const page = await acme.tn_projects.paginate({ limit: 10 });
      assert.deepEqual(page.items.map((p) => p.id), [a.id]);

      await assert.rejects(acme.tn_projects.update(g.id, { name: "Hacked" }), (e: InferloError) => e.code === "IL4001");
      assert.deepEqual(await acme.tn_projects.updateMany({ name: "Gemini" }, { name: "Hacked" }), []);
      assert.equal(await acme.tn_projects.delete(g.id), false);
      assert.equal(await acme.tn_projects.deleteMany({ name: "Gemini" }), 0);
      assert.equal((await globex.tn_projects.get(g.id)).name, "Gemini");

      const all = await db.$allTenants().tn_projects.findMany({ orderBy: { name: "asc" } });
      assert.deepEqual(all.map((p) => [p.name, p.tenantId]), [["Apollo", "acme"], ["Gemini", "globex"]]);
      assert.equal(db.$allTenants().$tenantId, "all");
      assert.equal(db.$tenantId, null);

      assert.equal(await acme.tn_projects.delete(a.id), true);
      assert.equal(await globex.tn_projects.deleteMany({ id: { isNull: false } }), 1);
    });

    test("a client without a tenant refuses tenant-scoped tables with IL4027, and other tables work", async () => {
      await db.tn_members.insert({ name: "Ada" });
      assert.equal(await db.tn_members.count({ name: "Ada" }), 1);
      await assert.rejects(db.tn_projects.findMany(), (e: InferloError) => e.code === "IL4027" && e.message.includes("tn_projects") && e.fix!.includes("$tenant"));
      await assert.rejects(db.tn_projects.insert({ name: "X", slug: "x" }), (e: InferloError) => e.code === "IL4027");
      await assert.rejects(db.tn_projects.count(), (e: InferloError) => e.code === "IL4027");
      await assert.rejects(db.$allTenants().tn_projects.insert({ name: "X", slug: "x" }), (e: InferloError) => e.code === "IL4027" && e.fix!.includes("$tenant(tenantId)"));
      for (const bad of ["", "x".repeat(201), 42, null]) {
        assert.throws(() => db.$tenant(bad as never), (e: InferloError) => e.code === "IL4027");
      }
    });

    test("tenantId is never accepted as input", async () => {
      const acme = db.$tenant("acme");
      await assert.rejects(acme.tn_projects.insert({ name: "X", slug: "x", tenantId: "globex" } as never), (e: InferloError) => e.code === "IL1001");
      const p = await acme.tn_projects.insert({ name: "Y", slug: "y" });
      await assert.rejects(acme.tn_projects.update(p.id, { tenantId: "globex" } as never), (e: InferloError) => e.code === "IL1001");
      assert.equal((await acme.tn_projects.get(p.id)).tenantId, "acme");
      await acme.tn_projects.delete(p.id);
    });

    test("unique fields are unique per tenant", async () => {
      const acme = db.$tenant("acme");
      const globex = db.$tenant("globex");
      await acme.tn_projects.insert({ name: "Support", slug: "support" });
      await globex.tn_projects.insert({ name: "Support", slug: "support" });
      await assert.rejects(acme.tn_projects.insert({ name: "Again", slug: "support" }), (e: InferloError) => e.code === "IL4004");
      await acme.tn_projects.deleteMany({ slug: "support" });
      await globex.tn_projects.deleteMany({ slug: "support" });
    });

    test("references to tenant-scoped tables must stay in the tenant, and include loads only the tenant's rows", async () => {
      const acme = db.$tenant("acme");
      const globex = db.$tenant("globex");
      const mine = await acme.tn_projects.insert({ name: "Mine", slug: "mine" });
      const theirs = await globex.tn_projects.insert({ name: "Theirs", slug: "theirs" });
      const task = await acme.tn_tasks.insert({ title: "Write", projectId: mine.id });
      await assert.rejects(acme.tn_tasks.insert({ title: "Sneak", projectId: theirs.id }), (e: InferloError) => e.code === "IL1001" && e.message.includes("projectId"));
      await assert.rejects(acme.tn_tasks.update(task.id, { projectId: theirs.id }), (e: InferloError) => e.code === "IL1001");
      await assert.rejects(acme.tn_tasks.updateMany({ title: "Write" }, { projectId: theirs.id }), (e: InferloError) => e.code === "IL1001");
      // Refs to tables that are not tenant-scoped are not checked against the tenant.
      const member = await db.tn_members.insert({ name: "Grace" });
      await acme.tn_projects.update(mine.id, { ownerId: member.id });

      const withTasks = await acme.tn_projects.get(mine.id, { include: { tn_tasks: true, owner: true } });
      assert.deepEqual(withTasks.tn_tasks.map((x) => x.title), ["Write"]);
      assert.equal(withTasks.owner?.name, "Grace");
      const withProject = await acme.tn_tasks.get(task.id, { include: { project: true } });
      assert.equal(withProject.project.name, "Mine");

      // Transactions keep the tenant.
      await acme.$transaction(async (tx) => {
        assert.equal(tx.$tenantId, "acme");
        assert.equal(await (tx as unknown as typeof acme).tn_projects.find(theirs.id), null);
      });
      await acme.tn_projects.deleteMany({ id: { isNull: false } });
      await globex.tn_projects.deleteMany({ id: { isNull: false } });
    });

    test("ctx.db in routes is scoped to the signed-in user's tenant", async () => {
      const users = new Map<string, object>([["acme", ACME], ["acme2", ACME_2], ["globex", GLOBEX], ["loner", LONER]]);
      const app = createApp({ models, db: adapter, routes: [routes()], auth: bearer((token) => (users.get(token) as never) ?? null) });
      const call = (token: string | null, method: string, path: string, body?: unknown) =>
        app.fetch(new Request(`http://x${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));

      const created = await readJson<Row<typeof Project>>(await call("acme", "POST", "/projects", { name: "Apollo", slug: "apollo" }));
      assert.equal(created.tenantId, "acme");
      await call("globex", "POST", "/projects", { name: "Gemini", slug: "gemini" });

      assert.deepEqual((await readJson<{ name: string }[]>(await call("acme2", "GET", "/projects"))).map((p) => p.name), ["Apollo"]);
      assert.deepEqual((await readJson<{ name: string }[]>(await call("globex", "GET", "/projects"))).map((p) => p.name), ["Gemini"]);
      assert.equal((await call("globex", "GET", `/projects/${created.id}`)).status, 404);
      assert.equal((await call("globex", "PATCH", `/projects/${created.id}`, { name: "Hacked" })).status, 404);
      assert.deepEqual(await readJson(await call("globex", "DELETE", `/projects/${created.id}`)), { deleted: false });
      assert.equal((await call("acme2", "GET", `/projects/${created.id}`)).status, 200);
      const sent = await call("acme", "POST", "/projects", { name: "X", slug: "x", tenantId: "globex" });
      assert.equal(sent.status, 422);

      // A user without a tenant, and a public route without a user, get IL4027 for tenant tables only.
      const loner = await call("loner", "GET", "/projects");
      assert.equal(loner.status, 500);
      assert.equal((await readJson<{ error: { code: string } }>(loner)).error.code, "IL4027");
      assert.equal((await call("loner", "GET", "/members")).status, 200);
      assert.equal((await call(null, "GET", "/open")).status, 500);
      await db.$allTenants().tn_projects.findMany().then((rows) => Promise.all(rows.map((r) => db.$tenant(r.tenantId).tn_projects.delete(r.id))));
    });

    test("auth.tenant(user) picks the tenant, and an invalid tenant id is refused with IL4027", async () => {
      const users = new Map<string, object>([["a", { id: ACME.id, orgId: "acme" }], ["bad", { id: GLOBEX.id, orgId: 7 }]]);
      const auth = bearer((token) => (users.get(token) as never) ?? null, { tenant: (user) => (user as unknown as { orgId: string }).orgId });
      const app = createApp({ models, db: adapter, routes: [routes()], auth });
      const call = (token: string, method: string, path: string, body?: unknown) =>
        app.fetch(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
      const created = await readJson<Row<typeof Project>>(await call("a", "POST", "/projects", { name: "Orion", slug: "orion" }));
      assert.equal(created.tenantId, "acme");
      const bad = await call("bad", "GET", "/projects");
      assert.equal(bad.status, 500);
      assert.equal((await readJson<{ error: { code: string } }>(bad)).error.code, "IL4027");
      await db.$tenant("acme").tn_projects.delete(created.id);
    });
  });
}

describe("model(name, fields, { tenant: true })", () => {
  test("adds a read-only tenantId field, indexed, and makes unique indexes per tenant", () => {
    assert.equal(Project.tenant, true);
    assert.equal(Member.tenant, false);
    assert.equal((Project.fields as Record<string, { def: { system?: string } }>).tenantId?.def.system, "tenantId");
    assert.ok("tenantId" in Project.row.shape);
    assert.ok(!("tenantId" in Project.create.shape));
    assert.ok(!Project.create.safeParse({ name: "x", slug: "x", tenantId: "acme" }).ok);
    const indexes = Object.fromEntries(modelIndexes(Project));
    assert.match(indexes.tn_projects_slug_key!, /\("tenant_id", "slug"\)/);
    assert.match(indexes.tn_projects_tenant_id_idx!, /\("tenant_id"\)/);
  });

  test("invalid options raise IL4026, and a tenantId field of your own raises IL4006", () => {
    assert.throws(() => model("x_items", { a: t.string() }, { tenant: "yes" } as never), (e: InferloError) => e.code === "IL4026");
    assert.throws(() => model("x_items", { a: t.string() }, { tenants: true } as never), (e: InferloError) => e.code === "IL4026");
    assert.throws(() => model("x_items", { a: t.string() }, null as never), (e: InferloError) => e.code === "IL4026");
    assert.throws(() => model("x_items", { tenantId: t.string() }, { tenant: true }), (e: InferloError) => e.code === "IL4006");
    assert.doesNotThrow(() => model("x_items", { tenantId: t.string() }));
  });

  test("describe() lists tenantId as set automatically, and sessions() takes a tenant option", () => {
    const app = createApp({ models, routes: [] });
    const described = app.describe().models.find((m) => m.name === "tn_projects")!;
    assert.deepEqual(described.fields.tenantId, { type: "string", required: false, nullable: false, column: "tenant_id", index: true, description: "Set automatically from the current tenant" });
    const auth = sessions({ secret: "s".repeat(32), user: () => null, tenant: () => "acme" });
    assert.equal(auth.tenant!({ id: ACME.id }), "acme");
  });
});

