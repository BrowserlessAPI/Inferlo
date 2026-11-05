import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider, route } from "../../../src/index.ts";
import { readJson } from "../../../src/testing.ts";
import { models } from "../src/models.ts";
import { access } from "../src/permissions.ts";
import * as tickets from "../src/routes/tickets.ts";

function makeApp() {
  return createApp({
    models,
    routes: [tickets],
    db: memory(),
    auth: { resolve: () => null },
    permissions: access,
    ai: {
      providers: { mock: mockProvider({ respond: () => '{"priority":"urgent","summary":"Checkout is down for all users"}' }) },
      models: { fast: "mock:test" },
    },
  });
}

test("member opens a ticket, agent triages it with AI and closes it", async () => {
  const app = makeApp();
  const asha = await app.db.users.insert({ email: "asha@example.com", name: "Asha" });
  const ravi = await app.db.users.insert({ email: "ravi@example.com", name: "Ravi", role: "agent" });
  const member = { id: asha.id, name: asha.name, roles: [] };
  const agent = { id: ravi.id, name: ravi.name, roles: ["agent"] };

  const ticket = await readJson(
    await app.request("/tickets", { method: "POST", json: { title: "Checkout broken", body: "Payment page shows an error" }, as: member }),
    201,
  );
  assert.equal(ticket.priority, "normal");

  const mine = await readJson(await app.request("/tickets?status=open", { as: member }), 200);
  assert.equal(mine.length, 1);

  await readJson(await app.request(`/tickets/${ticket.id}/triage`, { method: "POST", as: member }), 403);
  const triaged = await readJson(await app.request(`/tickets/${ticket.id}/triage`, { method: "POST", as: agent }), 200);
  assert.equal(triaged.priority, "urgent");
  assert.equal(triaged.summary, "Checkout is down for all users");

  const closed = await readJson(await app.request(`/tickets/${ticket.id}/close`, { method: "POST", as: agent }), 200);
  assert.equal(closed.status, "closed");
});

test("app map lists tools for AI agents", () => {
  const d = makeApp().describe();
  assert.deepEqual(d.routes.filter((r) => r.tool).map((r) => r.tool).sort(), ["closeTicket", "createTicket", "getTicket", "listTickets"]);
});

test("route permissions are typed from Register", () => {
  // @ts-expect-error: a typo in a permission name is a type error.
  route.get("/typo", { permission: "tickets.clsoe" });
  // @ts-expect-error: a rule that needs a ticket cannot be a route permission (only { user } is passed).
  route.get("/needs-ticket", { permission: "tickets.view" });
  const ok = route.get("/agents", { permission: "tickets.close" }).handle(() => ({}));
  assert.equal(ok.options.permission, "tickets.close");
});

test("MCP tools/list leaves out tools the caller's permissions deny", async () => {
  const app = makeApp();
  const list = async (as?: { id: string; name: string; roles: string[] }) => {
    const res = await readJson(await app.request("/mcp", { method: "POST", as, json: { jsonrpc: "2.0", id: 1, method: "tools/list" } }), 200);
    return res.result.tools.map((x: { name: string }) => x.name).sort();
  };
  const member = { id: "00000000-0000-4000-8000-000000000001", name: "Asha", roles: [] };
  const agent = { id: "00000000-0000-4000-8000-000000000002", name: "Ravi", roles: ["agent"] };
  assert.deepEqual(await list(member), ["createTicket", "getTicket", "listTickets"]);
  assert.deepEqual(await list(agent), ["closeTicket", "createTicket", "getTicket", "listTickets"]);
});
