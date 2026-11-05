// Checks the setup docs/migrate-from-fastify.md recommends: fastify.register(inferloPlugin, { app, fallthrough: true })
// next to the Fastify routes, sharing one auth check, while routes move from Fastify to Inferlo at the same URLs.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { bearer, createApp, httpError, route, t } from "../src/index.ts";
import { inferloPlugin } from "../src/fastify.ts";

// One auth check for both, as in the guide.
const sessions = new Map([["token-alice", { id: "alice", roles: ["admin"] }]]);
const userFromToken = async (token: string | undefined) => (token ? (sessions.get(token) ?? null) : null);

type Ticket = { id: number; title: string; priority: string; ownerId: string };
const store: Ticket[] = [];

const createTicket = route
  .post("/tickets", { body: t.object({ title: t.string().min(3).max(200), priority: t.enum(["low", "normal", "urgent"]).default("normal") }) })
  .handle(({ body, user, status }) => {
    if (store.some((x) => x.title === body.title)) throw httpError(409, "A ticket with this title exists.");
    status(201);
    const ticket = { id: store.length + 1, ...body, ownerId: user.id };
    store.push(ticket);
    return ticket;
  });

const inferlo = createApp({ routes: [{ createTicket }], auth: bearer((token) => userFromToken(token)), logger: { info() {}, error() {} } });

// The Fastify auth hook, as before the migration.
async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await userFromToken(request.headers.authorization?.replace(/^Bearer /, ""));
  if (!user) return reply.code(401).send({ message: "Sign in required" });
  (request as FastifyRequest & { user: unknown }).user = user;
}

let fastify: FastifyInstance;
let base = "";
before(async () => {
  fastify = Fastify();
  fastify.addHook("onRequest", async (_request, reply) => {
    reply.raw.setHeader("x-request-seen", "fastify");
  });
  // Routes not moved yet, with Fastify's JSON schemas.
  fastify.get("/tickets/:id", { preHandler: requireUser, schema: { params: { type: "object", properties: { id: { type: "integer" } } } } }, async (request) => ({
    id: (request.params as { id: number }).id,
    from: "fastify",
    user: (request as FastifyRequest & { user: { id: string } }).user.id,
  }));
  fastify.get("/tickets", { preHandler: requireUser }, async () => ({ from: "fastify", count: store.length }));
  await fastify.register(inferloPlugin, { app: inferlo, fallthrough: true });
  base = await fastify.listen({ port: 0, host: "127.0.0.1" });
});
after(() => fastify.close());

const alice = { authorization: "Bearer token-alice", "content-type": "application/json" };

describe("migrating from Fastify (docs/migrate-from-fastify.md)", () => {
  test("routes not moved yet are still answered by Fastify with the shared auth", async () => {
    assert.deepEqual(await (await fetch(`${base}/tickets/7`, { headers: alice })).json(), { id: 7, from: "fastify", user: "alice" });
    assert.equal((await fetch(`${base}/tickets/7`)).status, 401);
  });

  test("moved routes are answered by Inferlo at the same URL, next to a Fastify route on the same path", async () => {
    const res = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 1, title: "Printer jam", priority: "normal", ownerId: "alice" });
    assert.equal(res.headers.get("x-request-seen"), "fastify", "onRequest hooks added before the plugin run for its requests");
    assert.deepEqual(await (await fetch(`${base}/tickets`, { headers: alice })).json(), { from: "fastify", count: 1 });
  });

  test("JSON schemas, reply.code and auth hooks become t.* schemas, httpError and the route's auth", async () => {
    const invalid = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "x" }) });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const anonymous = await fetch(`${base}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, "IL3001");
    assert.equal((await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) })).status, 409);
  });

  test("Inferlo serves its OpenAPI document; paths neither has stay Fastify's 404", async () => {
    assert.ok((await (await fetch(`${base}/openapi.json`)).json()).paths["/tickets"].post);
    const missing = await fetch(`${base}/nothing-here`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).message, "Route GET:/nothing-here not found", "Fastify's own 404");
  });
});
