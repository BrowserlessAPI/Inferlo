import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bearer, createApp, InferloError, notFound, route, serviceClient, ServiceCallError, t } from "../src/index.ts";

// The "tickets" service: its routes are imported by the caller for typed calls.
const tickets = new Map([["t-1", { id: "t-1", title: "Printer on fire", priority: "high" as "low" | "high" }]]);
const seen: { requestId: string | null; authorization: string | null }[] = [];

const getTicket = route.get("/tickets/:id").handle(({ params, headers }) => {
  seen.push({ requestId: headers.get("x-request-id"), authorization: headers.get("authorization") });
  const ticket = tickets.get(params.id);
  if (!ticket) throw notFound();
  return ticket;
});
const listTickets = route
  .get("/tickets", { query: t.object({ priority: t.enum(["low", "high"]).optional(), limit: t.int().min(1).max(100).default(20) }) })
  .handle(({ query }) => ({ items: [...tickets.values()].filter((x) => !query.priority || x.priority === query.priority).slice(0, query.limit) }));
const createTicket = route
  .post("/tickets", { body: t.object({ title: t.string().min(1).max(200), priority: t.enum(["low", "high"]).default("low") }) })
  .handle(({ body, status }) => {
    const ticket = { id: `t-${tickets.size + 1}`, ...body };
    tickets.set(ticket.id, ticket);
    status(201);
    return ticket;
  });
const removeTicket = route.delete("/tickets/:id").handle(({ params }) => void tickets.delete(params.id));
const exportTickets = route.get("/tickets.csv").handle(() => new Response("id,title\n", { headers: { "content-type": "text/csv" } }));

const ticketsApp = createApp({
  name: "tickets",
  routes: [{ getTicket, listTickets, createTicket, removeTicket, exportTickets }],
  auth: bearer((token) => (token === "service-token" ? { id: "00000000-0000-4000-8000-0000000000aa", roles: ["service"] } : null)),
  trustProxy: true,
  logging: { requests: false },
});

const client = (extra: Partial<Parameters<typeof serviceClient>[0]> = {}) =>
  serviceClient({ baseUrl: "http://tickets.internal", token: "service-token", fetch: ticketsApp.fetch, ...extra });

/** A fetch that never answers until the request is aborted (a timer keeps the test process alive meanwhile). */
const hangingFetch = (req: Request) =>
  new Promise<Response>((_, reject) => {
    const keepAlive = setTimeout(() => {}, 10_000);
    req.signal.addEventListener("abort", () => (clearTimeout(keepAlive), reject(req.signal.reason)));
  });

const ilError = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;

describe("serviceClient", () => {
  test("typed calls: path params, query, JSON body, status codes and 204", async () => {
    const c = client();
    const one = await c.call(getTicket, { params: { id: "t-1" } });
    assert.equal(one.title, "Printer on fire");
    const list = await c.call(listTickets, { query: { priority: "high" } });
    assert.deepEqual(list.items.map((x) => x.id), ["t-1"]);
    const created = await c.call(createTicket, { body: { title: "New one" } });
    assert.deepEqual(created, { id: "t-2", title: "New one", priority: "low" });
    assert.equal(await c.call(removeTicket, { params: { id: "t-2" } }), undefined);
    const csv = await c.call(exportTickets);
    assert.ok(csv instanceof Response);
    assert.equal(await csv.text(), "id,title\n");
  });

  test("types follow the route", () => {
    const c = client();
    // Compile-time checks only: these calls are never run.
    const never = false as boolean;
    if (never) {
      // @ts-expect-error params are required for a path with :id
      void c.call(getTicket);
      // @ts-expect-error the body must match the route's schema
      void c.call(createTicket, { body: { title: 1 } });
      // @ts-expect-error unknown query value
      void c.call(listTickets, { query: { priority: "urgent" } });
      void c.call(listTickets).then((r) => r.items[0]?.title.toUpperCase());
    }
    assert.ok(c);
  });

  test("path parameters are URL-encoded and a missing one raises IL2009", async () => {
    const calls: string[] = [];
    const c = client({ fetch: async (req) => (calls.push(new URL(req.url).pathname), Response.json({})) });
    await c.call(getTicket, { params: { id: "a/b c" } });
    assert.deepEqual(calls, ["/tickets/a%2Fb%20c"]);
    await assert.rejects(c.call(getTicket, { params: { id: "" } }), ilError("IL2009"));
  });

  test("a baseUrl path prefix (mount path or API version) comes before the route path", async () => {
    const calls: string[] = [];
    const c = serviceClient({ baseUrl: "https://api.example.com/v1/", fetch: async (req) => (calls.push(req.url), Response.json({})) });
    await c.call(getTicket, { params: { id: "t-1" } });
    assert.deepEqual(calls, ["https://api.example.com/v1/tickets/t-1"]);
  });

  test("the token and the caller's request id are sent; the answer of an error status raises IL2008 with the remote status and code", async () => {
    seen.length = 0;
    const c = client();
    await c.call(getTicket, { params: { id: "t-1" }, ctx: { requestId: "req-abc-123", signal: new AbortController().signal } });
    assert.deepEqual(seen.at(-1), { requestId: "req-abc-123", authorization: "Bearer service-token" });
    const error = await c.call(getTicket, { params: { id: "missing" } }).catch((e: unknown) => e);
    assert.ok(error instanceof ServiceCallError);
    assert.equal(error.code, "IL2008");
    assert.equal(error.status, 502, "the caller answers 502 unless it handles the error");
    assert.equal(error.remoteStatus, 404);
    assert.equal(error.remoteCode, "IL4001");
    assert.equal(error.expose, false);
    const unauthorized = await client({ token: "wrong" }).call(getTicket, { params: { id: "t-1" } }).catch((e: unknown) => e);
    assert.ok(unauthorized instanceof ServiceCallError && unauthorized.remoteStatus === 401);
    assert.match(unauthorized.fix ?? "", /token/);
  });

  test("a handler turns a remote 404 into its own", async () => {
    const c = client();
    const show = route.get("/orders/:ticketId/ticket").handle(async (ctx) => {
      try {
        return await c.call(getTicket, { params: { id: ctx.params.ticketId }, ctx });
      } catch (error) {
        if (error instanceof ServiceCallError && error.remoteStatus === 404) throw notFound();
        throw error;
      }
    });
    const orders = createApp({ routes: [{ show }], auth: { resolve: () => ({ id: "00000000-0000-4000-8000-000000000001", roles: [] }) }, logging: { requests: false } });
    assert.equal((await orders.request("/orders/t-1/ticket")).status, 200);
    assert.equal((await orders.request("/orders/nope/ticket")).status, 404);
  });

  test("timeouts and network errors raise IL2008 with remote status 0", async () => {
    const slow = client({ timeoutMs: 20, fetch: hangingFetch });
    const timedOut = await slow.call(getTicket, { params: { id: "t-1" } }).catch((e: unknown) => e);
    assert.ok(timedOut instanceof ServiceCallError && timedOut.remoteStatus === 0);
    assert.match(timedOut.message, /did not answer within 20 ms/);
    const down = client({ fetch: async () => Promise.reject(new TypeError("fetch failed")) });
    const unreachable = await down.call(getTicket, { params: { id: "t-1" } }).catch((e: unknown) => e);
    assert.ok(unreachable instanceof ServiceCallError && /could not be reached: fetch failed/.test(unreachable.message));
  });

  test("retries repeat idempotent calls on 503 and network errors, never POST", async () => {
    let calls = 0;
    const flaky = client({ retries: 2, fetch: async (req) => (++calls < 3 ? new Response("busy", { status: 503 }) : ticketsApp.fetch(req)) });
    assert.equal((await flaky.call(getTicket, { params: { id: "t-1" } })).id, "t-1");
    assert.equal(calls, 3);
    calls = 0;
    const post = client({ retries: 2, fetch: async () => (++calls, new Response("busy", { status: 503 })) });
    const error = await post.call(createTicket, { body: { title: "x" } }).catch((e: unknown) => e);
    assert.ok(error instanceof ServiceCallError && error.remoteStatus === 503);
    assert.equal(calls, 1);
    calls = 0;
    const noRetries = client({ fetch: async () => (++calls, new Response("busy", { status: 503 })) });
    await assert.rejects(noRetries.call(getTicket, { params: { id: "t-1" } }), ilError("IL2008"));
    assert.equal(calls, 1, "no retries unless configured");
  });

  test("aborting the caller's request cancels the call with the caller's reason", async () => {
    const controller = new AbortController();
    const hanging = client({ fetch: hangingFetch });
    const pending = hanging.call(getTicket, { params: { id: "t-1" }, ctx: { requestId: "r", signal: controller.signal } });
    controller.abort(new Error("client went away"));
    await assert.rejects(pending, /client went away/);
  });

  test("invalid options raise IL2009", () => {
    assert.throws(() => serviceClient({ baseUrl: "tickets.internal" }), ilError("IL2009"));
    assert.throws(() => serviceClient({ baseUrl: "ftp://tickets.internal" }), ilError("IL2009"));
    assert.throws(() => serviceClient({ baseUrl: "http://tickets.internal?x=1" }), ilError("IL2009"));
    assert.throws(() => serviceClient({ baseUrl: "http://tickets.internal", timeoutMs: 0 }), ilError("IL2009"));
    assert.throws(() => serviceClient({ baseUrl: "http://tickets.internal", retries: 1.5 }), ilError("IL2009"));
    assert.throws(() => serviceClient({ baseUrl: "http://tickets.internal", retry: 2 } as never), ilError("IL2009"));
  });

  test("client.call() without a route raises IL2009", async () => {
    const call = client().call as (route: unknown) => Promise<unknown>;
    await assert.rejects(call({}), ilError("IL2009"));
  });
});
