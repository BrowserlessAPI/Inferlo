import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "../../../src/index.ts";
import { readJson } from "../../../src/testing.ts";
import { models } from "../src/models.ts";
import * as tickets from "../src/routes/tickets.ts";

function makeApp() {
  return createApp({
    models,
    routes: [tickets],
    db: memory(),
    auth: { resolve: () => null },
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
  assert.deepEqual(d.routes.filter((r) => r.tool).map((r) => r.tool).sort(), ["createTicket", "getTicket", "listTickets"]);
});
