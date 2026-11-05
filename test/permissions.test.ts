import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { InferloError, bearer, createApp, job, permissions, route, t, type AppUser } from "../src/index.ts";
import { readJson } from "../src/testing.ts";

const ALICE = { id: "11111111-1111-4111-8111-111111111111", roles: ["admin"] };
const BOB = { id: "22222222-2222-4222-8222-222222222222", roles: ["analyst"] };
const CAROL = { id: "33333333-3333-4333-8333-333333333333", roles: [] as string[] };

interface Ticket {
  id: string;
  ownerId: string;
}

const access = permissions({
  "reports.view": { roles: ["admin", "analyst"] },
  "tickets.update": ({ user, ticket }: { user: AppUser; ticket: Ticket }) => ticket.ownerId === user.id || (user.roles ?? []).includes("admin"),
  "tickets.export": async ({ user }: { user: AppUser }) => user.id === ALICE.id,
});

const tickets: Ticket[] = [{ id: "t1", ownerId: CAROL.id }];
const users = new Map([
  ["alice", ALICE],
  ["bob", BOB],
  ["carol", CAROL],
]);

function makeApp() {
  const routes = {
    viewReports: route.get("/reports", { permission: "reports.view", tool: true }).handle(() => ({ total: 3 })),
    updateTicket: route
      .patch("/tickets/:id", { body: t.object({ title: t.string() }) })
      .handle(async ({ params, body, user }) => {
        const ticket = tickets.find((x) => x.id === params.id)!;
        await access.authorize("tickets.update", { user, ticket });
        return { ...ticket, title: body.title };
      }),
  };
  return createApp({ routes: [routes], auth: bearer((token) => users.get(token) ?? null), permissions: access });
}

describe("permissions()", () => {
  test("can() checks roles rules and function rules, sync and async", async () => {
    const ticket = tickets[0]!;
    assert.equal(await access.can("reports.view", { user: BOB }), true);
    assert.equal(await access.can("reports.view", { user: CAROL }), false);
    assert.equal(await access.can("tickets.update", { user: CAROL, ticket }), true, "the owner");
    assert.equal(await access.can("tickets.update", { user: ALICE, ticket }), true, "an admin");
    assert.equal(await access.can("tickets.update", { user: BOB, ticket }), false);
    assert.equal(await access.can("tickets.export", { user: ALICE }), true);
    assert.equal(await access.can("tickets.export", { user: BOB }), false);
  });

  test("a missing user is always denied, without calling the rule", async () => {
    let called = false;
    const p = permissions({ open: () => (called = true) });
    assert.equal(await p.can("open", { user: null }), false);
    assert.equal(await p.can("open", undefined as never), false);
    assert.equal(called, false);
    assert.equal(await access.can("reports.view", { user: undefined }), false);
  });

  test("authorize() throws IL3004 (403) when denied and IL3001 (401) without a user", async () => {
    await access.authorize("reports.view", { user: ALICE });
    await assert.rejects(access.authorize("reports.view", { user: CAROL }), (e: unknown) => e instanceof InferloError && e.code === "IL3004" && e.status === 403 && e.message.includes("reports.view"));
    await assert.rejects(access.authorize("reports.view", { user: null }), (e: unknown) => e instanceof InferloError && e.code === "IL3001" && e.status === 401);
  });

  test("a rule must return true or false, and unknown permissions are errors", async () => {
    const p = permissions({ sloppy: (() => "yes") as unknown as () => boolean, missing: (() => undefined) as unknown as () => boolean });
    await assert.rejects(p.can("sloppy", { user: ALICE }), (e: unknown) => e instanceof InferloError && e.code === "IL6026" && /returned string/.test(e.message));
    await assert.rejects(p.authorize("missing", { user: ALICE }), (e: unknown) => e instanceof InferloError && e.code === "IL6026" && /returned undefined/.test(e.message));
    await assert.rejects(access.can("nope" as never, { user: ALICE } as never), (e: unknown) => e instanceof InferloError && e.code === "IL6026" && /Unknown permission "nope"/.test(e.message));
  });

  test("invalid definitions raise IL6026", () => {
    const bad = (rules: unknown) => assert.throws(() => permissions(rules as never), (e: unknown) => e instanceof InferloError && e.code === "IL6026");
    bad(null);
    bad([]);
    bad({ "": () => true });
    bad({ "bad name": () => true });
    bad({ x: { roles: [] } });
    bad({ x: { roles: "admin" } });
    bad({ x: { roles: ["admin"], extra: true } });
    bad({ x: true });
  });

  test("the result is frozen and lists its permissions", () => {
    assert.ok(Object.isFrozen(access));
    assert.deepEqual(access.list, [{ name: "reports.view", roles: ["admin", "analyst"] }, { name: "tickets.update" }, { name: "tickets.export" }]);
    assert.equal(access.has("reports.view"), true);
    assert.equal(access.has("nope"), false);
  });
});

describe("permissions in an app", () => {
  test("a route's permission is checked before the handler", async () => {
    const app = makeApp();
    assert.equal((await readJson(await app.request("/reports"), 401)).error.code, "IL3001");
    const denied = await readJson(await app.request("/reports", { headers: { authorization: "Bearer carol" } }), 403);
    assert.equal(denied.error.code, "IL3004");
    assert.match(denied.error.message, /reports\.view/);
    assert.deepEqual(await readJson(await app.request("/reports", { headers: { authorization: "Bearer bob" } }), 200), { total: 3 });
  });

  test("authorize() in a handler answers 403 with IL3004", async () => {
    const app = makeApp();
    const edit = (token: string) => app.request("/tickets/t1", { method: "PATCH", headers: { authorization: `Bearer ${token}` }, json: { title: "New" } });
    assert.equal((await readJson(await edit("bob"), 403)).error.code, "IL3004");
    assert.equal((await readJson(await edit("carol"), 200)).title, "New");
    assert.equal((await readJson(await edit("alice"), 200)).title, "New");
  });

  test("the permission also applies when the route is called as an MCP tool", async () => {
    const app = makeApp();
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "viewReports", arguments: {} } };
    const denied = await readJson(await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer carol" }, json: rpc }), 200);
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /IL3004/);
    const ok = await readJson(await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer alice" }, json: rpc }), 200);
    assert.equal(ok.result.isError, false);
  });

  test("the same rules work in a job", async () => {
    const exported: string[] = [];
    const exportTickets = job("export-tickets", { input: t.object({ userId: t.string() }) }).handle(async ({ input }) => {
      const user = [...users.values()].find((u) => u.id === input.userId) ?? null;
      await access.authorize("tickets.export", { user: user! });
      exported.push(input.userId);
    });
    const app = createApp({ jobs: [exportTickets], permissions: access });
    await app.jobs.enqueue(exportTickets, { userId: ALICE.id });
    await app.jobs.runDue();
    assert.deepEqual(exported, [ALICE.id]);
  });

  test("describe, OpenAPI and inferlo describe show permissions", () => {
    const app = makeApp();
    const d = app.describe();
    assert.deepEqual(d.permissions, [{ name: "reports.view", roles: ["admin", "analyst"] }, { name: "tickets.update" }, { name: "tickets.export" }]);
    assert.equal(d.routes.find((r) => r.path === "/reports")!.permission, "reports.view");
    assert.equal(d.routes.find((r) => r.path === "/tickets/:id")!.permission, undefined);
    const op = (app.openapi() as any).paths["/reports"].get;
    assert.equal(op["x-inferlo-permission"], "reports.view");
    assert.match(op.responses["403"].description, /IL3004/);
    assert.equal(createApp({ auth: bearer(() => null), routes: [] }).describe().permissions.length, 0);
  });

  test("createApp checks route permissions at startup (IL6026)", () => {
    const auth = bearer(() => null);
    const fails = (config: Parameters<typeof createApp>[0], pattern: RegExp) =>
      assert.throws(() => createApp(config), (e: unknown) => e instanceof InferloError && e.code === "IL6026" && pattern.test(e.message));
    const reports = route.get("/reports", { permission: "reports.view" }).handle(() => ({}));
    fails({ auth, routes: [reports] }, /createApp has no permissions/);
    fails({ auth, routes: [route.get("/x", { permission: "nope" }).handle(() => ({}))], permissions: access }, /unknown permission "nope"/);
    fails({ auth, routes: [route.get("/x", { auth: "public", permission: "reports.view" }).handle(() => ({}))], permissions: access }, /auth: "public"/);
    fails({ auth, routes: [], permissions: { "reports.view": { roles: ["admin"] } } as never }, /permissions\(\{ \.\.\. \}\)/);
  });
});
