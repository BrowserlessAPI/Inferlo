// Checks the setup docs/migrate-from-express.md recommends: an Inferlo app mounted at the root after the
// Express routes, sharing one auth check, while routes move from Express to Inferlo at the same URLs.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import express from "express";
import { bearer, createApp, route, t, toNodeHandler } from "../src/index.ts";

const quiet = { info() {}, error() {} };

// One auth check for both, as in the guide.
const sessions = new Map([["token-alice", { id: "alice", roles: ["admin"] }]]);
const userFromToken = async (token: string | undefined) => (token ? (sessions.get(token) ?? null) : null);

const tickets: { id: number; title: string; priority: string; ownerId: string }[] = [];

const createTicket = route
  .post("/tickets", {
    body: t.object({ title: t.string().min(3).max(200), priority: t.enum(["low", "normal", "urgent"]).default("normal") }),
  })
  .handle(async ({ body, user, status }) => {
    status(201);
    const ticket = { id: tickets.length + 1, ...body, ownerId: user.id };
    tickets.push(ticket);
    return ticket;
  });

const inferlo = createApp({ routes: [{ createTicket }], auth: bearer((token) => userFromToken(token)), logger: quiet });

const server = express();
server.use(express.json());
const requireUser: express.RequestHandler = async (req, res, next) => {
  const user = await userFromToken(req.get("authorization")?.replace(/^Bearer /, ""));
  if (!user) return void res.status(401).json({ error: "Sign in required" });
  res.locals.user = user;
  next();
};
server.get("/users/:id", requireUser, (req, res) => void res.json({ id: req.params.id, from: "express" }));
server.get("/boom", () => {
  throw new Error("express route failed");
});
server.use(toNodeHandler(inferlo));
server.use((_req: express.Request, res: express.Response) => void res.status(404).json({ from: "express 404" }));
server.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => void res.status(500).json({ from: "express error handler" }));

let base = "";
let close: () => Promise<void>;
before(async () => {
  const http = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => http.close(() => resolve()));
});
after(() => close());

const alice = { authorization: "Bearer token-alice", "content-type": "application/json" };

describe("migrating from Express (docs/migrate-from-express.md)", () => {
  test("routes not moved yet are still answered by Express, with the shared auth", async () => {
    const res = await fetch(`${base}/users/7`, { headers: alice });
    assert.deepEqual(await res.json(), { id: "7", from: "express" });
    assert.equal((await fetch(`${base}/users/7`)).status, 401);
  });

  test("moved routes are answered by Inferlo at the same URL, after express.json() read the body", async () => {
    const res = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "Printer jam" }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { id: 1, title: "Printer jam", priority: "normal", ownerId: "alice" });
    const invalid = await fetch(`${base}/tickets`, { method: "POST", headers: alice, body: JSON.stringify({ title: "x", priority: "asap" }) });
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, "IL1001");
    const anonymous = await fetch(`${base}/tickets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Printer jam" }) });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, "IL3001");
  });

  test("Inferlo answers unknown paths with 404 IL2001, and Express routes still reach the Express error handler", async () => {
    const missing = await fetch(`${base}/nothing-here`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, "IL2001");
    const failed = await fetch(`${base}/boom`);
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { from: "express error handler" });
  });
});
