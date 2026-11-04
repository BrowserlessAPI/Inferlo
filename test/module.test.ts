import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bearer, createApp, InferloError, isModule, job, model, module, route, t, type AppDb, type Db } from "../src/index.ts";

const quiet = { info: () => {}, error: () => {} };

const users = model("mod_users", { email: t.email(), name: t.string() });
// Handlers get the registered app's db; these tests have no Register, so they name their tables here.
const tables = (db: AppDb) => db as unknown as Db<[typeof users, typeof invoices]>;
const findUser = (db: AppDb, id: string) => tables(db).mod_users.find(id);
const listUsers = route.get("/users", { auth: "public", summary: "List users" }).handle(({ db }) => tables(db).mod_users.findMany());

const usersModule = module("users", {
  description: "People who sign in.",
  models: [users],
  routes: [{ listUsers }],
  provides: { findUser },
});

const invoices = model("mod_invoices", { userId: t.ref("mod_users"), amountCents: t.int().min(0) });
const sendInvoice = job("send-invoice", { input: t.object({ invoiceId: t.uuid() }) }).handle(() => {});
const createInvoice = route
  .post("/invoices", { body: t.object({ userId: t.uuid(), amountCents: t.int() }), tags: ["money"] })
  .handle(async ({ body, db, jobs }) => {
    const user = await usersModule.provides.findUser(db, body.userId);
    if (!user) return new Response(null, { status: 404 });
    const invoice = await tables(db).mod_invoices.insert(body);
    await jobs.enqueue(sendInvoice, { invoiceId: invoice.id });
    return invoice;
  });
const listInvoices = route.get("/invoices", { auth: "public" }).handle(({ db }) => tables(db).mod_invoices.findMany());

const billing = module("billing", {
  imports: [usersModule],
  models: [invoices],
  routes: [{ createInvoice, listInvoices }],
  jobs: [sendInvoice],
  provides: { invoiceTotal: (items: { amountCents: number }[]) => items.reduce((sum, i) => sum + i.amountCents, 0) },
});

const settingsModel = model("mod_settings", { key: t.string() });
const health = route.get("/ping", { auth: "public" }).handle(() => ({ ok: true }));

function makeApp() {
  return createApp({
    models: [settingsModel],
    routes: [{ health }],
    modules: [usersModule, billing],
    auth: bearer((token) => (token === "good" ? { id: "u1" } : null)),
    logger: quiet,
  });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof InferloError, `expected an InferloError, got ${String(e)}`);
    return e.code;
  }
  assert.fail("expected an error");
}

describe("modules", () => {
  test("module() returns a frozen plain value", () => {
    assert.ok(isModule(billing));
    assert.equal(billing.name, "billing");
    assert.deepEqual(billing.imports, [usersModule]);
    assert.ok(Object.isFrozen(billing));
    assert.ok(Object.isFrozen(billing.provides));
    assert.equal(billing.provides.invoiceTotal([{ amountCents: 2 }, { amountCents: 3 }]), 5);
    assert.equal(isModule({ name: "x" }), false);
  });

  test("models, routes and jobs of modules join the app, typed", async () => {
    const app = makeApp();
    assert.deepEqual(app.models.map((m) => m.name), ["mod_settings", "mod_users", "mod_invoices"]);
    assert.deepEqual(app.modules.map((m) => m.name), ["users", "billing"]);
    const user = await app.db.mod_users.insert({ email: "a@example.com", name: "Ada" });
    const res = await app.request("/invoices", { method: "POST", json: { userId: user.id, amountCents: 1200 }, as: { id: "u1" } });
    assert.equal(res.status, 200);
    const invoice = (await res.json()) as { id: string; amountCents: number };
    assert.equal(invoice.amountCents, 1200);
    const typed: number = (await app.db.mod_invoices.findMany())[0]!.amountCents;
    assert.equal(typed, 1200);
    assert.equal((await app.request("/users")).status, 200);
    assert.equal((await app.request("/ping")).status, 200);
    const jobs = await app.jobs.runDue();
    assert.equal(jobs.done, 1);
  });

  test("describe() lists modules and marks what belongs to each", () => {
    const d = makeApp().describe();
    assert.deepEqual(d.modules, [
      { name: "users", description: "People who sign in.", imports: [], models: ["mod_users"], routes: ["GET /users"], jobs: [], provides: ["findUser"] },
      { name: "billing", imports: ["users"], models: ["mod_invoices"], routes: ["POST /invoices", "GET /invoices"], jobs: ["send-invoice"], provides: ["invoiceTotal"] },
    ]);
    assert.equal(d.models.find((m) => m.name === "mod_invoices")?.module, "billing");
    assert.equal(d.models.find((m) => m.name === "mod_settings")?.module, undefined);
    assert.equal(d.routes.find((r) => r.path === "/users")?.module, "users");
    assert.equal(d.routes.find((r) => r.path === "/ping")?.module, undefined);
    assert.equal(d.jobs.find((j) => j.name === "send-invoice")?.module, "billing");
  });

  test("OpenAPI tags module routes with the module name unless the route sets tags", () => {
    const doc = makeApp().openapi() as { tags: unknown; paths: Record<string, Record<string, { tags?: string[] }>> };
    assert.deepEqual(doc.tags, [{ name: "users", description: "People who sign in." }, { name: "billing" }]);
    assert.deepEqual(doc.paths["/users"]!.get!.tags, ["users"]);
    assert.deepEqual(doc.paths["/invoices"]!.get!.tags, ["billing"]);
    assert.deepEqual(doc.paths["/invoices"]!.post!.tags, ["money"]);
    assert.equal(doc.paths["/ping"]!.get!.tags, undefined);
    const plain = createApp({ routes: [{ health }], logger: quiet }).openapi() as { tags?: unknown };
    assert.equal(plain.tags, undefined);
  });

  test("an app without modules describes an empty list", () => {
    assert.deepEqual(createApp({ logger: quiet }).describe().modules, []);
  });

  test("module() checks its name and options (IL6022)", () => {
    assert.equal(code(() => module("Billing")), "IL6022");
    assert.equal(code(() => module("")), "IL6022");
    assert.equal(code(() => module("billing", { model: [invoices] } as never)), "IL6022");
    assert.equal(code(() => module("billing", { routes: { createInvoice } } as never)), "IL6022");
    assert.equal(code(() => module("billing", { imports: [{ name: "users" }] } as never)), "IL6022");
    assert.equal(code(() => module("billing", { imports: [usersModule, usersModule] })), "IL6022");
    assert.equal(code(() => module("billing", { models: ["invoices"] } as never)), "IL6022");
    assert.equal(code(() => module("billing", { provides: [] as never })), "IL6022");
    try {
      module("billing", { model: [invoices] } as never);
    } catch (e) {
      assert.match((e as Error).message, /Did you mean "models"/);
    }
  });

  test("every imported module must be registered (IL6023)", () => {
    try {
      createApp({ modules: [billing], logger: quiet, auth: bearer(() => null) });
      assert.fail("expected an error");
    } catch (e) {
      assert.equal((e as InferloError).code, "IL6023");
      assert.match((e as Error).message, /"billing" imports "users", which is not in createApp\(\{ modules \}\)/);
      assert.match((e as InferloError).fix ?? "", /Add users to createApp/);
    }
  });

  test("module names, models and list entries are unique (IL6023)", () => {
    const other = module("users", { models: [model("mod_others", { x: t.string() })] });
    assert.equal(code(() => createApp({ modules: [usersModule, other], logger: quiet })), "IL6023");
    assert.equal(code(() => createApp({ modules: [usersModule, usersModule], logger: quiet })), "IL6023");
    const shared = module("shared", { models: [users] });
    assert.equal(code(() => createApp({ modules: [usersModule, shared], logger: quiet })), "IL6023");
    assert.equal(code(() => createApp({ models: [users], modules: [usersModule], logger: quiet })), "IL6023");
    assert.equal(code(() => createApp({ modules: [{ name: "x" }] as never, logger: quiet })), "IL6023");
    assert.equal(code(() => createApp({ modules: usersModule as never, logger: quiet })), "IL6023");
  });

  test("a model may only reference models of its module, an imported module or the app (IL6024)", () => {
    const sneaky = module("reports", { models: [model("mod_reports", { userId: t.ref("mod_users") })] });
    try {
      createApp({ modules: [usersModule, sneaky], logger: quiet, auth: bearer(() => null) });
      assert.fail("expected an error");
    } catch (e) {
      assert.equal((e as InferloError).code, "IL6024");
      assert.match((e as Error).message, /mod_reports\.userId in the module "reports" references "mod_users" from the module "users"/);
      assert.match((e as InferloError).fix ?? "", /imports: \[users\]/);
    }
    const toApp = module("audit", { models: [model("mod_audit", { settingId: t.ref("mod_settings") })] });
    assert.doesNotThrow(() => createApp({ models: [settingsModel], modules: [toApp], logger: quiet }));
  });

  test("a route in a module and in createApp({ routes }) is a duplicate route", () => {
    assert.equal(code(() => createApp({ routes: [{ listUsers }], modules: [usersModule], logger: quiet })), "IL6001");
  });
});
