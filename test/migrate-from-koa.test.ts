// Checks the setup docs/migrate-from-koa.md recommends: a body parser, then
// koa.use(toKoaMiddleware(inferlo, { fallthrough: true })) before the Koa routes, sharing one auth check, while
// routes move from Koa to Inferlo at the same URLs.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import Koa from "koa";
import { bearer, createApp, httpError, route, t } from "../src/index.ts";
import { toKoaMiddleware } from "../src/koa.ts";

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

const requireUser: Koa.Middleware = async (ctx, next) => {
  const user = await userFromToken(ctx.get("authorization").replace(/^Bearer /, "") || undefined);
  if (!user) ctx.throw(401, "Sign in required");
  ctx.state.user = user;
  await next();
};

/** What @koa/bodyparser does: read the stream and put the parsed JSON on ctx.request.body. */
const bodyParser: Koa.Middleware = async (ctx, next) => {
  if (ctx.is("application/json")) {
    let raw = "";
    for await (const chunk of ctx.req) raw += chunk;
    (ctx.request as { body?: unknown }).body = raw ? JSON.parse(raw) : {};
  }
  await next();
};

/** The routes not moved yet, as @koa/router would match them. */
const koaRoutes: Koa.Middleware = async (ctx, next) => {
  const one = /^\/tickets\/(\d+)$/.exec(ctx.path);
  if (ctx.method === "GET" && one) {
    await requireUser(ctx, async () => {
      ctx.body = { id: one[1], from: "koa", user: ctx.state.user.id };
    });
    return;
  }
  if (ctx.method === "GET" && ctx.path === "/tickets") {
    await requireUser(ctx, async () => {
      ctx.body = { from: "koa", count: store.length };
    });
    return;
  }
  await next();
};

let base = "";
let close: () => Promise<void>;
before(async () => {
  const koa = new Koa();
  koa.use(async (ctx, next) => {
    ctx.set("x-request-seen", "koa");
    await next();
  });
  koa.use(bodyParser);
  koa.use(toKoaMiddleware(inferlo, { fallthrough: true }));
  koa.use(koaRoutes);
  const http = koa.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => http.close(() => resolve()));
});
after(() => close());

const alice = { authorization: "Bearer token-alice", "content-type": "application/json" };

describe("migrating from Koa (docs/migrate-from-koa.md)", () => {
  test("routes not moved yet are still answered by Koa with the shared auth", async () => {
    assert.deepEqual(await (await fetch(`${base}/tickets/7`, { headers: alice })).json(), { id: "7", from: "koa", user: "alice" });
    assert.equal((await fetch(`${base}/tickets/7`)).status, 401);
  });

  test("moved routes are answered by Inferlo at the same URL, next to a Koa route on the same path", async () => {
    const res = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 1, title: "Printer jam", priority: "normal", ownerId: "alice" });
    assert.equal(res.headers.get("x-request-seen"), "koa", "Koa middleware before Inferlo runs for its requests");
    assert.deepEqual(await (await fetch(`${base}/tickets`, { headers: alice })).json(), { from: "koa", count: 1 });
  });

  test("hand-written checks, ctx.throw and auth become schemas, httpError and the route's auth", async () => {
    const invalid = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "x" }) });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const anonymous = await fetch(`${base}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, "IL3001");
    assert.equal((await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) })).status, 409);
  });

  test("Inferlo serves its OpenAPI document; paths neither has stay Koa's 404", async () => {
    assert.ok((await (await fetch(`${base}/openapi.json`)).json()).paths["/tickets"].post);
    const missing = await fetch(`${base}/nothing-here`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not Found", "Koa's own 404");
  });
});
