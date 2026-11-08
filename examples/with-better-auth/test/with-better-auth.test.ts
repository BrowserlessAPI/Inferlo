import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { makeApp } from "../src/app.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const BASE = "http://app.test";
const quiet = { info() {}, error() {} };
let ctx: ReturnType<typeof makeApp>;

const BETTER_AUTH_TABLES = ["user", "session", "account", "verification"];

async function dropAll() {
  await ctx.pool.query(`drop table if exists "projects", "session", "account", "verification", "user" cascade`);
}

/**
 * Better Auth's pending migrations, read again if another example test drops or changes one of its own tables while
 * Better Auth (through Kysely) reads the database's tables (42P01 or 42703): the example tests share one test database
 * and run at the same time.
 */
async function pendingMigrations(): Promise<Awaited<ReturnType<typeof getMigrations>>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getMigrations(ctx.auth.options);
    } catch (error) {
      const code = String((error as { code?: unknown }).code ?? "");
      if (attempt === 20 || (code !== "42P01" && code !== "42703")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

function call(path: string, init: { method?: string; headers?: Record<string, string>; json?: unknown } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  return ctx.app.fetch(new Request(BASE + path, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) }));
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await call("/api/auth/sign-up/email", { method: "POST", headers: { origin: BASE }, json: { email, password: "correct horse battery", name } });
  assert.equal(res.status, 200, await res.clone().text());
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp({ databaseUrl: PG_URL, secret: "with-better-auth-example-secret-0123456789abcdef", baseURL: BASE, logger: quiet });
  await dropAll();
  // Better Auth's tables, from its own migrations (npx @better-auth/cli migrate in a real app), then Inferlo's.
  const { runMigrations } = await pendingMigrations();
  await runMigrations();
  await ctx.app.db.$sync();
});
after(async () => {
  if (!PG_URL) return;
  await dropAll();
  await ctx.app.close();
  await ctx.pool.end();
});

test("a user signs up with Better Auth and uses Inferlo routes with the session cookie", { skip }, async () => {
  const cookie = await signUp("ada@example.com", "Ada");
  const created = await call("/projects", { method: "POST", headers: { cookie, origin: BASE }, json: { name: "Engine" } });
  assert.equal(created.status, 201);
  const project = (await created.json()) as { id: string; ownerId: string; name: string };
  assert.equal(project.name, "Engine");

  const [owner] = await ctx.app.db.$sql(`select id from "user" where email = $1`, ["ada@example.com"]);
  assert.equal(project.ownerId, owner!.id, "the project belongs to Better Auth's user");

  const list = (await (await call("/projects", { headers: { cookie } })).json()) as { name: string }[];
  assert.deepEqual(list.map((p) => p.name), ["Engine"]);
  const one = (await (await call(`/projects/${project.id}`, { headers: { cookie } })).json()) as { owner: { name: string; email: string } };
  assert.deepEqual(one.owner, { name: "Ada", email: "ada@example.com" });
});

test("routes stay private, other users' projects are forbidden, and admins see every project", { skip }, async () => {
  assert.equal((await call("/projects")).status, 401);
  const ada = await signUp("ada2@example.com", "Ada");
  const bob = await signUp("bob@example.com", "Bob");
  const res = await call("/projects", { method: "POST", headers: { cookie: ada, origin: BASE }, json: { name: "Private" } });
  const { id } = (await res.json()) as { id: string };
  assert.equal((await call(`/projects/${id}`, { headers: { cookie: bob } })).status, 403);
  assert.equal((await call("/admin/projects", { headers: { cookie: bob } })).status, 403);
  assert.equal((await call("/projects/00000000-0000-4000-8000-000000000000", { headers: { cookie: bob } })).status, 404);
  assert.equal((await call("/projects", { method: "POST", headers: { cookie: bob, origin: BASE }, json: { name: "" } })).status, 422);

  // The admin plugin's role, set in Better Auth's user table, is the route's auth: "admin".
  await ctx.pool.query(`update "user" set role = 'admin' where email = 'bob@example.com'`);
  const all = await call("/admin/projects", { headers: { cookie: bob } });
  assert.equal(all.status, 200);
  assert.ok(((await all.json()) as { id: string }[]).some((p) => p.id === id));
  assert.equal((await call(`/projects/${id}`, { headers: { cookie: bob } })).status, 200);
});

test("another site cannot change data with a signed-in user's cookie", { skip }, async () => {
  const cookie = await signUp("csrf@example.com", "Cy");
  const before = await ctx.app.db.projects.count();
  const res = await call("/projects", { method: "POST", headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" }, json: { name: "Spam" } });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL3007");
  assert.equal(await ctx.app.db.projects.count(), before);
});

test("sign-out ends the session for Inferlo routes too", { skip }, async () => {
  const cookie = await signUp("out@example.com", "Out");
  assert.equal((await call("/projects", { headers: { cookie } })).status, 200);
  const out = await call("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: BASE }, json: {} });
  assert.equal(out.status, 200);
  assert.equal((await call("/projects", { headers: { cookie } })).status, 401);
});

test("Better Auth's migrations and Inferlo's sync leave each other's tables alone", { skip }, async () => {
  const pending = await pendingMigrations();
  assert.deepEqual(pending.toBeCreated, []);
  assert.deepEqual(pending.toBeAdded, []);
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => !BETTER_AUTH_TABLES.some((table) => s.includes(`"${table}"`))), statements.join("\n"));
  const columns = await ctx.app.db.$sql("select column_name from information_schema.columns where table_name = 'projects' order by column_name");
  assert.deepEqual(columns.map((c) => c.column_name), ["created_at", "id", "name", "owner_id", "updated_at"]);
});
