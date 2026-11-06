// WebSocket rooms (socket.join, sockets.broadcast): broadcasts from routes, WebSocket handlers, jobs and app.sockets,
// leaving rooms, closed sockets, tenants, and invalid rooms, on a real server from app.listen() (Node.js, Bun and Deno).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { bearer, createApp, InferloError, job, memory, route, t, type AppUser } from "../src/index.ts";

const quiet = { info: () => {}, error: () => {} };
const users = new Map<string, { id: string; tenantId?: string }>([
  ["ada-token", { id: "ada", tenantId: "acme" }],
  ["bob-token", { id: "bob", tenantId: "acme" }],
  ["cy-token", { id: "cy", tenantId: "globex" }],
  ["dee-token", { id: "dee" }],
]);
const asAcme = (id: string): AppUser & { tenantId: string } => ({ id, tenantId: "acme" });
const auth = bearer((token) => users.get(token) ?? null);

const room = route
  .ws("/room", { message: t.object({ action: t.enum(["join", "leave", "say", "ping", "bad-room"]), room: t.string().max(50).optional(), text: t.string().max(200).optional() }) })
  .handle(async ({ message, socket, sockets, user }) => {
    if (message.action === "join") socket.join(message.room!);
    if (message.action === "leave") socket.leave(message.room!);
    if (message.action === "say") await sockets.broadcast(message.room!, { type: "said", from: user.id, text: message.text });
    if (message.action === "bad-room") socket.join("");
    return { ok: message.action };
  });

const notify = job("notify-room", { input: t.object({ room: t.string(), text: t.string() }) }).handle(async ({ input, sockets }) => {
  await sockets.broadcast(input.room, { type: "job", text: input.text });
});

const post = route.post("/rooms/:room/notes", { body: t.object({ text: t.string().max(200), later: t.boolean().optional() }) }).handle(async ({ params, body, sockets, jobs }) => {
  if (body.later) await jobs.enqueue(notify, { room: params.room, text: body.text });
  else await sockets.broadcast(params.room, { type: "note", text: body.text });
  return { sent: true };
});

const app = createApp({ db: memory(), routes: [room, post], jobs: [notify], auth, logger: quiet });

type Client = { ws: WebSocket; next(): Promise<any>; send(data: unknown): void; closed: Promise<unknown> };
function connect(port: number, token: string): Promise<Client> {
  const WS = WebSocket as unknown as new (url: string, init?: object) => WebSocket;
  const ws = new WS(`ws://127.0.0.1:${port}/room`, { headers: { authorization: `Bearer ${token}` } });
  const queue: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    const resolve = waiting.shift();
    if (resolve) resolve(data);
    else queue.push(data);
  };
  const closed = new Promise((resolve) => (ws.onclose = resolve));
  return new Promise((resolve, reject) => {
    ws.onopen = () =>
      resolve({
        ws,
        closed,
        send: (data) => ws.send(JSON.stringify(data)),
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r))),
      });
    ws.onerror = () => reject(new Error("connection refused"));
  });
}

/** Sends a message and returns the replies up to its { ok } answer, so anything broadcast before it is in the list. */
async function call(client: Client, message: Record<string, unknown>): Promise<unknown[]> {
  client.send(message);
  const seen: unknown[] = [];
  while (true) {
    const reply = await client.next();
    if (reply && typeof reply === "object" && "ok" in reply && reply.ok === message.action) return seen;
    seen.push(reply);
  }
}

describe("WebSocket rooms", () => {
  let server: { port: number; close(): Promise<void> };
  const clients: Client[] = [];
  const open = async (token: string) => {
    const client = await connect(server.port, token);
    clients.push(client);
    return client;
  };
  before(async () => {
    server = await app.listen(0, "127.0.0.1");
  });
  after(async () => {
    for (const client of clients) client.ws.close();
    await server.close();
  });

  test("a route's broadcast reaches every socket in the room, and no other", async () => {
    const [ada, bob, other] = [await open("ada-token"), await open("bob-token"), await open("bob-token")];
    await call(ada, { action: "join", room: "project:1" });
    await call(bob, { action: "join", room: "project:1" });
    await call(other, { action: "join", room: "project:2" });
    assert.equal(app.sockets.count("project:1", { tenantId: "acme" }), 2);

    const res = await app.request("/rooms/project:1/notes", { method: "POST", json: { text: "hello" }, as: asAcme("ada") });
    assert.equal(res.status, 200);
    assert.deepEqual(await call(ada, { action: "ping" }), [{ type: "note", text: "hello" }]);
    assert.deepEqual(await call(bob, { action: "ping" }), [{ type: "note", text: "hello" }]);
    assert.deepEqual(await call(other, { action: "ping" }), []);
  });

  test("a WebSocket handler broadcasts to the room, the sender included", async () => {
    const [ada, bob] = [await open("ada-token"), await open("bob-token")];
    await call(ada, { action: "join", room: "chat" });
    await call(bob, { action: "join", room: "chat" });
    assert.deepEqual(await call(ada, { action: "say", room: "chat", text: "hi bob" }), [{ type: "said", from: "ada", text: "hi bob" }]);
    assert.deepEqual(await call(bob, { action: "ping" }), [{ type: "said", from: "ada", text: "hi bob" }]);
  });

  test("socket.leave(room) stops broadcasts to that socket", async () => {
    const ada = await open("ada-token");
    await call(ada, { action: "join", room: "leaving" });
    await call(ada, { action: "leave", room: "leaving" });
    assert.equal(app.sockets.count("leaving", { tenantId: "acme" }), 0);
    await app.sockets.broadcast("leaving", { type: "late" }, { tenantId: "acme" });
    assert.deepEqual(await call(ada, { action: "ping" }), []);
  });

  test("a closed socket leaves every room", async () => {
    const before = app.sockets.count();
    const ada = await connect(server.port, "ada-token");
    await call(ada, { action: "join", room: "closing" });
    assert.equal(app.sockets.count(), before + 1);
    assert.equal(app.sockets.count("closing", { tenantId: "acme" }), 1);
    ada.ws.close();
    await ada.closed;
    for (let i = 0; i < 50 && app.sockets.count("closing", { tenantId: "acme" }) > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(app.sockets.count("closing", { tenantId: "acme" }), 0);
    assert.equal(app.sockets.count(), before);
    await app.sockets.broadcast("closing", { type: "nobody" }, { tenantId: "acme" });
  });

  test("rooms are per tenant: a broadcast reaches only the sockets of its tenant", async () => {
    const [ada, cy, dee] = [await open("ada-token"), await open("cy-token"), await open("dee-token")];
    for (const client of [ada, cy, dee]) await call(client, { action: "join", room: "board" });
    assert.deepEqual(await call(cy, { action: "say", room: "board", text: "globex only" }), [{ type: "said", from: "cy", text: "globex only" }]);
    await app.request("/rooms/board/notes", { method: "POST", json: { text: "acme only" }, as: asAcme("bob") });
    await app.sockets.broadcast("board", { type: "none" });
    await app.sockets.broadcast("board", { type: "to-globex" }, { tenantId: "globex" });

    assert.deepEqual(await call(ada, { action: "ping" }), [{ type: "note", text: "acme only" }]);
    assert.deepEqual(await call(cy, { action: "ping" }), [{ type: "to-globex" }]);
    assert.deepEqual(await call(dee, { action: "ping" }), [{ type: "none" }]);
  });

  test("a job broadcasts to the rooms of the tenant that queued it", async () => {
    const [ada, cy] = [await open("ada-token"), await open("cy-token")];
    await call(ada, { action: "join", room: "reports" });
    await call(cy, { action: "join", room: "reports" });
    await app.request("/rooms/reports/notes", { method: "POST", json: { text: "ready", later: true }, as: asAcme("ada") });
    await app.jobs.runDue();
    assert.deepEqual(await call(ada, { action: "ping" }), [{ type: "job", text: "ready" }]);
    assert.deepEqual(await call(cy, { action: "ping" }), []);
  });

  test("an invalid room is IL2014, sent back to the socket, which stays open", async () => {
    const ada = await open("ada-token");
    ada.send({ action: "bad-room" });
    const reply = await ada.next();
    assert.equal(reply.error.code, "IL2014");
    assert.deepEqual(await call(ada, { action: "ping" }), []);
  });
});

describe("app.sockets", () => {
  test("broadcast checks the room, the data and the tenant", async () => {
    await assert.rejects(app.sockets.broadcast("", { a: 1 }), (e: unknown) => e instanceof InferloError && e.code === "IL2014" && /room/.test(e.fix ?? ""));
    await assert.rejects(app.sockets.broadcast("x".repeat(201), { a: 1 }), (e: unknown) => e instanceof InferloError && e.code === "IL2014");
    await assert.rejects(app.sockets.broadcast(42 as never, { a: 1 }), (e: unknown) => e instanceof InferloError && e.code === "IL2014");
    await assert.rejects(app.sockets.broadcast("room", undefined), (e: unknown) => e instanceof InferloError && e.code === "IL2014");
    await assert.rejects(app.sockets.broadcast("room", { a: 1 }, { tenantId: "" }), (e: unknown) => e instanceof InferloError && e.code === "IL4027");
    await app.sockets.broadcast("empty-room", { a: 1 });
    assert.equal(app.sockets.count("empty-room"), 0);
  });
});
