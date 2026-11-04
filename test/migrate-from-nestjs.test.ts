// Checks the setup docs/migrate-from-nestjs.md recommends: an Inferlo app mounted with
// toNodeHandler(app, { fallthrough: true }) before the NestJS routes, sharing one auth check, while routes
// move from NestJS controllers to Inferlo at the same URLs, and services become plain functions in modules.
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Controller, Get, Injectable, Module, Param, UseGuards, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { bearer, createApp, httpError, module, route, t, toNodeHandler } from "../src/index.ts";

// Decorators are applied by hand: Node runs this file without a decorator transform.
function decorate<T extends abstract new (...args: any[]) => unknown>(target: T, classDecorators: ClassDecorator[], deps: unknown[] = []): T {
  Reflect.defineMetadata("design:paramtypes", deps, target);
  for (const decorator of classDecorators) decorator(target);
  return target;
}
function method(target: object, key: string, ...decorators: MethodDecorator[]) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
  for (const d of decorators) d(target, key, descriptor);
}

// One auth check for both, as in the guide.
const sessions = new Map([
  ["token-alice", { id: "alice", roles: ["admin"] }],
  ["token-bob", { id: "bob", roles: [] }],
]);
const userFromToken = async (token: string | undefined) => (token ? (sessions.get(token) ?? null) : null);

// NestJS side: a guard using the shared check and a controller not moved yet.
class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: unknown }>();
    req.user = await userFromToken(req.headers.authorization?.replace(/^Bearer /, ""));
    return Boolean(req.user);
  }
}
decorate(AuthGuard, [Injectable()]);

class TicketsController {
  findOne(id: string) {
    return { id, from: "nest" };
  }
}
method(TicketsController.prototype, "findOne", Get(":id"), UseGuards(AuthGuard));
Param("id")(TicketsController.prototype, "findOne", 0);
decorate(TicketsController, [Controller("tickets")]);

class AppModule {}
decorate(AppModule, [Module({ controllers: [TicketsController], providers: [AuthGuard] })]);

// Inferlo side: the moved routes, in a module, with the service as plain functions in provides.
type Ticket = { id: string; title: string; priority: "low" | "normal" | "urgent"; ownerId: string };
const store: Ticket[] = [];
const ticketService = {
  create: (data: Omit<Ticket, "id">): Ticket => {
    const ticket = { id: String(store.length + 1), ...data };
    store.push(ticket);
    return ticket;
  },
  list: (ownerId: string) => store.filter((t) => t.ownerId === ownerId),
};
const CreateTicket = t.object({ title: t.string().min(3).max(200), priority: t.enum(["low", "normal", "urgent"]).default("normal") });
const createTicket = route.post("/tickets", { body: CreateTicket, summary: "Create a ticket" }).handle(({ body, user, status }) => {
  if (store.some((t) => t.title === body.title)) throw httpError(409, "A ticket with this title exists.");
  status(201);
  return ticketService.create({ ...body, ownerId: user.id });
});
const listTickets = route.get("/tickets", {}).handle(({ user }) => ticketService.list(user.id));
const purge = route.delete("/tickets", { auth: "admin" }).handle(() => void store.splice(0));
const tickets = module("tickets", { routes: [{ createTicket, listTickets, purge }], provides: ticketService });

const inferlo = createApp({ modules: [tickets], auth: bearer((token) => userFromToken(token)), logger: { info() {}, error() {} } });

let base = "";
let nest: Awaited<ReturnType<typeof NestFactory.create>>;
before(async () => {
  nest = await NestFactory.create(AppModule, { logger: false });
  nest.use(toNodeHandler(inferlo, { fallthrough: true }));
  await nest.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(nest.getHttpServer().address() as { port: number }).port}`;
});
after(() => nest.close());

const alice = { authorization: "Bearer token-alice", "content-type": "application/json" };
const bob = { authorization: "Bearer token-bob", "content-type": "application/json" };

describe("migrating from NestJS (docs/migrate-from-nestjs.md)", () => {
  test("controllers not moved yet are still answered by NestJS, with the shared auth in a guard", async () => {
    const res = await fetch(`${base}/tickets/7`, { headers: alice });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "7", from: "nest" });
    assert.equal((await fetch(`${base}/tickets/7`)).status, 403);
  });

  test("moved routes are answered by Inferlo at the same URL, next to NestJS routes on the same path", async () => {
    const res = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: "1", title: "Printer jam", priority: "normal", ownerId: "alice" });
    const list = await fetch(`${base}/tickets`, { headers: alice });
    assert.deepEqual((await list.json()).map((t: Ticket) => t.title), ["Printer jam"]);
    assert.deepEqual(await (await fetch(`${base}/tickets`, { headers: bob })).json(), []);
  });

  test("DTO validation, guards and exceptions become schemas, auth and httpError", async () => {
    const invalid = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "x", priority: "asap" }) });
    assert.equal(invalid.status, 422);
    const body = await invalid.json();
    assert.equal(body.error.code, "IL1001");
    assert.deepEqual(body.error.details.map((d: { path: string[] }) => d.path.join(".")).sort(), ["priority", "title"]);
    assert.equal((await fetch(`${base}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    const duplicate = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) });
    assert.equal(duplicate.status, 409);
    assert.equal((await fetch(`${base}/tickets`, { method: "DELETE", headers: bob })).status, 403);
    assert.equal((await fetch(`${base}/tickets`, { method: "DELETE", headers: alice })).status, 204);
  });

  test("unknown paths still get the NestJS 404, and the Inferlo module is in describe and OpenAPI", async () => {
    const missing = await fetch(`${base}/nothing-here`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).message, "Cannot GET /nothing-here");
    assert.deepEqual(inferlo.describe().modules[0]?.routes, ["POST /tickets", "GET /tickets", "DELETE /tickets"]);
    const doc = await (await fetch(`${base}/openapi.json`)).json();
    assert.deepEqual(doc.paths["/tickets"].post.tags, ["tickets"]);
  });
});
