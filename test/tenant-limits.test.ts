import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { AuditLog, InferloError, createApp, job, memory, route, t, type Adapter, type AppUser } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { checkRateLimit } from "../src/rate-limit.ts";
import { checkRouteCache } from "../src/cache.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const quiet = { info: () => {}, error: () => {} };
const auth = { resolve: () => null };

const ALICE: AppUser = { id: "alice", tenantId: "acme" } as AppUser;
const AMIR: AppUser = { id: "amir", tenantId: "acme" } as AppUser;
const BOB: AppUser = { id: "bob", tenantId: "globex" } as AppUser;
const LONER: AppUser = { id: "loner" };
const LONER2: AppUser = { id: "loner2" };
const ORG_USER: AppUser = { id: "olga", orgId: "initech" } as AppUser;

function makeApp(extra: Record<string, unknown> = {}) {
  let calls = 0;
  const ask = route.post("/ask", { rateLimit: { max: 2, per: "hour", by: "tenant" } }).handle(() => ({ ok: true }));
  const stats = route.get("/stats", { cache: { ttlMs: 60_000, by: "tenant" } }).handle((ctx) => ({ call: ++calls, user: ctx.user!.id }));
  const app = createApp({ routes: [{ ask, stats }], auth, logger: quiet, ...extra });
  return app;
}

describe("rateLimit by tenant", () => {
  test("every user of a tenant shares one count, and other tenants have their own", async () => {
    const app = makeApp();
    assert.equal((await app.request("/ask", { method: "POST", as: ALICE })).status, 200);
    const second = await app.request("/ask", { method: "POST", as: AMIR });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("ratelimit-remaining"), "0");
    const third = await app.request("/ask", { method: "POST", as: ALICE });
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error.code, "IL2005");
    assert.equal((await app.request("/ask", { method: "POST", as: BOB })).status, 200);
  });

  test("users without a tenant are counted one by one", async () => {
    const app = makeApp();
    for (let i = 0; i < 2; i++) assert.equal((await app.request("/ask", { method: "POST", as: LONER })).status, 200);
    assert.equal((await app.request("/ask", { method: "POST", as: LONER })).status, 429);
    assert.equal((await app.request("/ask", { method: "POST", as: LONER2 })).status, 200);
  });

  test("the tenant comes from auth.tenant(user) when the app names it", async () => {
    const app = makeApp({ auth: { resolve: () => null, tenant: (user: AppUser) => (user as { orgId?: string }).orgId ?? null } });
    for (let i = 0; i < 2; i++) assert.equal((await app.request("/ask", { method: "POST", as: { ...ORG_USER, id: `olga${i}` } })).status, 200);
    assert.equal((await app.request("/ask", { method: "POST", as: ORG_USER })).status, 429);
  });

  test("checkRateLimit accepts by: tenant and names it in the error for other values", () => {
    checkRateLimit({ max: 1, per: "minute", by: "tenant" }, "POST /x");
    assert.throws(
      () => checkRateLimit({ max: 1, per: "minute", by: "org" }, "POST /x"),
      (e: InferloError) => e.code === "IL6007" && /"user", "tenant" or "ip"/.test(e.message) && /by: "user" \| "tenant" \| "ip"/.test(e.fix ?? ""),
    );
  });
});

describe("route cache by tenant", () => {
  test("users of one tenant share a cached response, other tenants do not", async () => {
    const app = makeApp();
    const first = await app.request("/stats", { as: ALICE });
    assert.equal(first.headers.get("x-inferlo-cache"), "MISS");
    assert.equal(first.headers.get("cache-control"), "private, no-cache");
    assert.match(first.headers.get("vary") ?? "", /Authorization, Cookie/);
    const body = await first.json();
    const shared = await app.request("/stats", { as: AMIR });
    assert.equal(shared.headers.get("x-inferlo-cache"), "HIT");
    assert.deepEqual(await shared.json(), body);
    const other = await app.request("/stats", { as: BOB });
    assert.equal(other.headers.get("x-inferlo-cache"), "MISS");
    assert.equal((await other.json()).user, "bob");
  });

  test("users without a tenant get their own cached response", async () => {
    const app = makeApp();
    assert.equal((await app.request("/stats", { as: LONER })).headers.get("x-inferlo-cache"), "MISS");
    const mine = await app.request("/stats", { as: LONER });
    assert.equal(mine.headers.get("x-inferlo-cache"), "HIT");
    const theirs = await app.request("/stats", { as: LONER2 });
    assert.equal(theirs.headers.get("x-inferlo-cache"), "MISS");
    assert.equal((await theirs.json()).user, "loner2");
  });

  test("checkRouteCache accepts by: tenant, and describe shows it", () => {
    checkRouteCache({ ttlMs: 1000, by: "tenant" }, "GET", "GET /x");
    assert.throws(() => checkRouteCache({ ttlMs: 1000, by: "org" }, "GET", "GET /x"), (e: InferloError) => e.code === "IL6028" && /"user", "tenant" or "public"/.test(e.message));
    const map = makeApp().describe();
    const stats = map.routes.find((r) => r.path === "/stats")!;
    assert.equal(stats.cache?.by, "tenant");
    const ask = map.routes.find((r) => r.path === "/ask")!;
    assert.equal(ask.rateLimit?.by, "tenant");
  });
});

const adapters: [string, () => Adapter][] = [["memory", () => memory()]];
if (PG_URL) adapters.push(["postgres", () => postgres({ url: PG_URL })]);

for (const [name, makeDb] of adapters) {
  describe(`audit entries record the tenant (${name})`, () => {
    const db = makeDb();
    after(() => db.close?.());

    test("routes record the signed-in user's tenant, jobs the tenant they run for", async () => {
      const id = `${name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const action = `tl.${id}`;
      const note = job(`tl-audit-${id}`, { input: t.object({}), retries: 0 }).handle(async (ctx) => {
        await ctx.audit(action, { data: { from: "job" } });
      });
      const write = route.post("/write").handle(async (ctx) => {
        await ctx.audit(action, { data: { from: "route" } });
        await ctx.jobs.enqueue(note, {});
        return { ok: true };
      });
      const app = createApp({ models: [AuditLog], db, routes: [{ write }], jobs: [note], auth, logger: quiet });
      await app.db.$sync();
      assert.equal((await app.request("/write", { method: "POST", as: ALICE })).status, 200);
      assert.equal((await app.request("/write", { method: "POST", as: LONER })).status, 200);
      await app.jobs.runDue();
      await app.jobs.runDue();
      const rows = (await app.db.audit_log.findMany({ where: { action } })) as unknown as { userId?: string; tenantId?: string | null; data: { from: string } }[];
      const summary = rows.map((r) => `${r.data.from}:${r.userId ?? "-"}:${r.tenantId ?? "-"}`).sort();
      assert.deepEqual(summary, ["job:-:-", "job:-:acme", "route:alice:acme", "route:loner:-"]);
      assert.equal((await app.db.audit_log.findMany({ where: { action, tenantId: "acme" } })).length, 2);
    });

    test("an entry can name its tenant, or null for none", async () => {
      const action = `tl2.${name}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const app = createApp({ models: [AuditLog], db, logger: quiet });
      await app.db.$sync();
      const write = route.post("/w").handle(async (ctx) => {
        await ctx.audit(action, { tenantId: "globex", data: { n: 1 } });
        await ctx.audit(action, { tenantId: null, data: { n: 2 } });
        return null;
      });
      const app2 = createApp({ models: [AuditLog], db, routes: [{ write }], auth, logger: quiet });
      assert.equal((await app2.request("/w", { method: "POST", as: ALICE })).status, 200);
      const rows = (await app.db.audit_log.findMany({ where: { action } })) as unknown as { tenantId?: string | null; data: { n: number } }[];
      assert.deepEqual(rows.map((r) => `${r.data.n}:${r.tenantId ?? "-"}`).sort(), ["1:globex", "2:-"]);
    });

    test("an invalid tenantId raises IL6027", async () => {
      const write = route.post("/bad").handle(async (ctx) => {
        await ctx.audit("x", { tenantId: 42 as unknown as string });
        return null;
      });
      const logged: unknown[] = [];
      const app = createApp({ models: [AuditLog], db, routes: [{ write }], auth, logger: { info() {}, error: (m: string) => void logged.push(m) } });
      await app.db.$sync();
      const res = await app.request("/bad", { method: "POST", as: ALICE });
      assert.equal(res.status, 500);
      assert.ok(logged.some((m) => /IL6027/.test(String(m)) && /tenantId/.test(String(m))), "logs IL6027");
    });
  });
}
