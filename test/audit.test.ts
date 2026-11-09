import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { postgres } from "../src/db/postgres.ts";
import { postgresJsAdapter } from "./postgres-js-adapter.ts";
import { AuditLog, InferloError, auditChanges, bearer, createApp, job, memory, model, route, t, type Adapter } from "../src/index.ts";
import { readJson } from "../src/testing.ts";
import { sqlite } from "../src/db/sqlite.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const adapters: [string, () => Adapter][] = [["memory", () => memory()], ["sqlite", () => sqlite()]];
if (PG_URL) adapters.push(["postgres", () => postgres({ url: PG_URL })]);
if (PG_URL) adapters.push(["postgres.js", () => postgresJsAdapter(PG_URL)]);

const Account = model("audit_accounts", {
  name: t.string(),
  plan: t.enum(["free", "pro"]).default("free"),
  apiKeyHash: t.string().optional(),
  renewsAt: t.date().optional(),
});

const ALICE = { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"] };

const renew = job("renew-account", { input: t.object({ accountId: t.string(), userId: t.string() }) }).handle(async ({ input, db, audit }) => {
  const before = await (db as any).audit_accounts.get(input.accountId);
  const after = await (db as any).audit_accounts.update(input.accountId, { renewsAt: new Date("2027-01-01T00:00:00.000Z") });
  await audit("accounts.renew", { model: "audit_accounts", before, after, userId: input.userId });
  await audit("accounts.checked", { recordId: input.accountId });
});

function makeApp(adapter: Adapter, logs: unknown[] = []) {
  const routes = {
    createAccount: route.post("/accounts", { body: t.object({ name: t.string() }) }).handle(async ({ body, db, audit, status }) => {
      const account = await (db as any).audit_accounts.insert(body);
      await audit("accounts.create", { model: "audit_accounts", after: account });
      status(201);
      return account;
    }),
    updateAccount: route
      .patch("/accounts/:id", { body: t.object({ plan: t.enum(["free", "pro"]).optional(), apiKeyHash: t.string().optional() }) })
      .handle(async ({ params, body, db, audit }) => {
        const before = await (db as any).audit_accounts.get(params.id);
        const updated = await (db as any).audit_accounts.update(params.id, body);
        await audit("accounts.update", { model: "audit_accounts", before, after: updated, data: { reason: "upgrade", token: "tok_live_1234567890abcdef" } });
        return updated;
      }),
    deleteAccount: route.delete("/accounts/:id").handle(async ({ params, db, audit }) => {
      const before = await (db as any).audit_accounts.get(params.id);
      await (db as any).audit_accounts.delete(params.id);
      await audit("accounts.delete", { model: "audit_accounts", before });
    }),
  };
  return createApp({
    models: [Account, AuditLog],
    routes: [routes],
    jobs: [renew],
    db: adapter,
    auth: bearer((token) => (token === "alice" ? ALICE : null)),
    logger: { info() {}, error: (...args: unknown[]) => void logs.push(args) },
  });
}

for (const [name, make] of adapters) {
  describe(`audit log (${name})`, () => {
    const app = makeApp(make());
    const db = app.db as any;
    before(async () => {
      if (name !== "memory" && name !== "sqlite") await db.$sql('DROP TABLE IF EXISTS "audit_log", "audit_accounts" CASCADE');
      await db.$sync();
    });
    after(() => db.$close());

    test("routes record the user, action, record, changes and request id", async () => {
      const created = await app.request("/accounts", { method: "POST", as: ALICE, json: { name: "Acme" } });
      const account = await readJson(created, 201);
      const updated = await app.request(`/accounts/${account.id}`, { method: "PATCH", as: ALICE, json: { plan: "pro", apiKeyHash: "abc123hash" } });
      await readJson(updated, 200);
      assert.equal(await db.audit_log.count({ recordId: account.id }), 2);
      const create = await db.audit_log.findOne({ recordId: account.id, action: "accounts.create" });
      const update = await db.audit_log.findOne({ recordId: account.id, action: "accounts.update" });
      assert.equal(create.action, "accounts.create");
      assert.equal(create.userId, ALICE.id);
      assert.equal(create.model, "audit_accounts");
      assert.equal(create.source, "POST /accounts");
      assert.equal(create.requestId, created.headers.get("x-request-id"));
      assert.deepEqual(create.changes.name, { from: null, to: "Acme" });
      assert.deepEqual(create.changes.plan, { from: null, to: "free" });
      assert.equal(create.changes.id, undefined, "id, createdAt and updatedAt are not changes");

      assert.equal(update.action, "accounts.update");
      assert.deepEqual(update.changes, { plan: { from: "free", to: "pro" }, apiKeyHash: "[redacted]" });
      assert.equal(update.data.reason, "upgrade");
      assert.equal(update.data.token, "[redacted]", "secret fields in data are redacted");
      assert.equal(update.requestId, updated.headers.get("x-request-id"));
      assert.equal(update.source, "PATCH /accounts/:id");
    });

    test("deletes keep the last values, and jobs record the given user", async () => {
      const account = await db.audit_accounts.insert({ name: "Globex" });
      await app.jobs.enqueue(renew, { accountId: account.id, userId: ALICE.id });
      await app.jobs.runDue();
      const renewed = [
        await db.audit_log.findOne({ recordId: account.id, action: "accounts.renew" }),
        await db.audit_log.findOne({ recordId: account.id, action: "accounts.checked" }),
      ];
      assert.equal(renewed[0].action, "accounts.renew");
      assert.equal(renewed[0].userId, ALICE.id);
      assert.equal(renewed[0].source, "job renew-account");
      assert.equal(renewed[0].requestId, null);
      assert.deepEqual(renewed[0].changes, { renewsAt: { from: null, to: "2027-01-01T00:00:00.000Z" } });
      assert.equal(renewed[1].action, "accounts.checked");
      assert.equal(renewed[1].userId, null, "system work without a user");
      assert.equal(renewed[1].changes, null);

      assert.equal((await app.request(`/accounts/${account.id}`, { method: "DELETE", as: ALICE })).status, 204);
      const [deleted] = await db.audit_log.findMany({ where: { recordId: account.id, action: "accounts.delete" } });
      assert.deepEqual(deleted.changes.name, { from: "Globex", to: null });
    });
  });
}

describe("audit without the AuditLog model", () => {
  test("ctx.audit raises IL6027 with the fix", async () => {
    const logs: unknown[] = [];
    const r = route.post("/x").handle(async ({ audit }) => {
      await audit("x.do");
      return {};
    });
    const app = createApp({ routes: [{ r }], auth: bearer(() => ALICE), logger: { info() {}, error: (...a: unknown[]) => void logs.push(a) } });
    const res = await app.request("/x", { method: "POST", as: ALICE });
    assert.equal(res.status, 500);
    const logged = String((logs[0] as unknown[])[0]);
    assert.match(logged, /IL6027/);
    assert.match(logged, /Add AuditLog to the app's models/);
  });

  test("invalid actions and entries raise IL6027", async () => {
    const results: string[] = [];
    const r = route.post("/x").handle(async ({ audit }) => {
      for (const call of [() => audit(""), () => audit("x", [] as never), () => audit(1 as never)]) {
        await call().catch((e: InferloError) => results.push(e.code));
      }
      return {};
    });
    const app = createApp({ models: [AuditLog], routes: [{ r }], auth: bearer(() => ALICE) });
    await readJson(await app.request("/x", { method: "POST", as: ALICE }), 200);
    assert.deepEqual(results, ["IL6027", "IL6027", "IL6027"]);
  });
});

test("auditChanges compares field values, dates as ISO strings", () => {
  const d = new Date("2026-01-01T00:00:00.000Z");
  assert.deepEqual(auditChanges({ id: "1", a: 1, d, tags: ["x"] }, { id: "1", a: 1, d: new Date(d), tags: ["x", "y"], password: "p" }), {
    tags: { from: ["x"], to: ["x", "y"] },
    password: "[redacted]",
  });
  assert.deepEqual(auditChanges(null, null), {});
});
