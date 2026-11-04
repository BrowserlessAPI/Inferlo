// Checks the setup docs/migrate-from-hono.md recommends: the Hono routes not moved yet first, then
// hono.all("*", (c) => inferlo.fetch(c.req.raw)), sharing one auth check, while routes move from Hono to
// Inferlo at the same URLs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Hono } from "hono";
import { apiVersion, bearer, createApp, httpError, route, t } from "../src/index.ts";

// One auth check for both, as in the guide.
const sessions = new Map([["token-alice", { id: "alice", roles: ["admin"] }]]);
const userFromToken = async (token: string | undefined) => (token ? (sessions.get(token) ?? null) : null);

type Ticket = { id: number; title: string; priority: string; ownerId: string };
const store: Ticket[] = [];

const createTicket = route
  .post("/tickets", { body: t.object({ title: t.string().min(3).max(200), priority: t.enum(["low", "normal", "urgent"]).default("normal") }) })
  .handle(({ body, user, status }) => {
    if (store.some((t) => t.title === body.title)) throw httpError(409, "A ticket with this title exists.");
    status(201);
    const ticket = { id: store.length + 1, ...body, ownerId: user.id };
    store.push(ticket);
    return ticket;
  });
const listTickets = route.get("/tickets", {}).handle(({ user }) => store.filter((t) => t.ownerId === user.id));
const status = route.get("/status", { auth: "public" }).handle(() => ({ ok: true }));

const inferlo = createApp({
  routes: [{ createTicket, listTickets }, apiVersion("v2", [{ status }])],
  auth: bearer((token) => userFromToken(token)),
  logger: { info() {}, error() {} },
});

type Env = { Variables: { user: { id: string; roles: string[] } } };
const hono = new Hono<Env>();
hono.get("/tickets/:id", async (c, next) => {
  const user = await userFromToken(c.req.header("authorization")?.replace(/^Bearer /, ""));
  if (!user) return c.json({ error: "Sign in required" }, 401);
  c.set("user", user);
  await next();
}, (c) => c.json({ id: c.req.param("id"), from: "hono", user: c.get("user").id }));
const books = new Hono();
books.get("/", (c) => c.json([{ title: "Dune" }]));
hono.route("/books", books);
hono.all("*", (c) => inferlo.fetch(c.req.raw)); // last: everything Hono does not answer

const alice = { authorization: "Bearer token-alice", "content-type": "application/json" };

describe("migrating from Hono (docs/migrate-from-hono.md)", () => {
  test("routes not moved yet, sub-apps included, are still answered by Hono with the shared auth", async () => {
    assert.deepEqual(await (await hono.request("/tickets/7", { headers: alice })).json(), { id: "7", from: "hono", user: "alice" });
    assert.equal((await hono.request("/tickets/7")).status, 401);
    assert.deepEqual(await (await hono.request("/books")).json(), [{ title: "Dune" }]);
  });

  test("moved routes are answered by Inferlo at the same URL, next to Hono routes on the same path", async () => {
    const res = await hono.request("/tickets", { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 1, title: "Printer jam", priority: "normal", ownerId: "alice" });
    assert.deepEqual((await (await hono.request("/tickets", { headers: alice })).json()).length, 1);
    assert.deepEqual(await (await hono.request("/v2/status")).json(), { ok: true });
  });

  test("validators, HTTPException and auth become schemas, httpError and the route's auth", async () => {
    const invalid = await hono.request("/tickets", { method: "POST", headers: alice, body: JSON.stringify({ title: "x" }) });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const anonymous = await hono.request("/tickets", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, "IL3001");
    assert.equal((await hono.request("/tickets", { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) })).status, 409);
  });

  test("Inferlo answers unknown paths with 404 IL2001 and serves its OpenAPI documents", async () => {
    const missing = await hono.request("/nothing-here");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "IL2001");
    assert.ok((await (await hono.request("/openapi.json")).json()).paths["/tickets"]);
    assert.ok((await (await hono.request("/v2/openapi.json")).json()).paths["/v2/status"]);
  });
});
