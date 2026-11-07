// WebSocket broadcasts across instances through Redis Pub/Sub (sockets: { transport: "redis" }): two instances of
// one app on real servers, a worker without sockets, tenants, other apps on the same Redis, shutdown, and the
// option checks. Needs INFERLO_TEST_REDIS_URL for the Redis tests.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createClient } from "redis";
import { bearer, createApp, InferloError, job, memory, route, t, type AppUser, type RedisClient, type RedisSubscriber } from "../src/index.ts";

const REDIS_URL = process.env.INFERLO_TEST_REDIS_URL;
const quiet = { info() {}, error() {} };
const run = `ws${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const users = new Map<string, { id: string; tenantId?: string }>([
  ["ada-token", { id: "ada", tenantId: "acme" }],
  ["cy-token", { id: "cy", tenantId: "globex" }],
  ["dee-token", { id: "dee" }],
]);
const acme: AppUser & { tenantId: string } = { id: "bob", tenantId: "acme" };

const watch = route.ws("/watch", { message: t.object({ room: t.string().max(50) }) }).handle(({ message, socket }) => {
  socket.join(message.room);
  return { ok: message.room };
});
const notify = job("ws-redis-notify", { input: t.object({ room: t.string(), text: t.string() }) }).handle(({ input, sockets }) => sockets.broadcast(input.room, { type: "job", text: input.text }));
const post = route.post("/rooms/:room", { body: t.object({ text: t.string().max(200), later: t.boolean().optional() }) }).handle(async ({ params, body, sockets, jobs }) => {
  if (body.later) await jobs.enqueue(notify, { room: params.room, text: body.text });
  else await sockets.broadcast(params.room, { type: "note", text: body.text });
  return { sent: true };
});

type Client = { ws: WebSocket; next(): Promise<any>; send(data: unknown): void };
function connect(port: number, token: string): Promise<Client> {
  const WS = WebSocket as unknown as new (url: string, init?: object) => WebSocket;
  const ws = new WS(`ws://127.0.0.1:${port}/watch`, { headers: { authorization: `Bearer ${token}` } });
  const queue: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    const resolve = waiting.shift();
    if (resolve) resolve(data);
    else queue.push(data);
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, send: (data) => ws.send(JSON.stringify(data)), next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r))) });
    ws.onerror = () => reject(new Error("connection refused"));
  });
}

async function join(client: Client, room: string): Promise<void> {
  client.send({ room });
  assert.deepEqual(await client.next(), { ok: room });
}

/** The messages a client got within a short wait (Pub/Sub delivery to another instance is asynchronous). */
async function received(client: Client, count: number, waitMs = 1000): Promise<unknown[]> {
  const out: unknown[] = [];
  const deadline = Date.now() + waitMs;
  while (out.length < count && Date.now() < deadline) {
    const next = await Promise.race([client.next(), new Promise((r) => setTimeout(() => r(undefined), deadline - Date.now()))]);
    if (next === undefined) break;
    out.push(next);
  }
  return out;
}

/** Nothing more arrives within waitMs. */
async function quietFor(client: Client, waitMs = 200): Promise<unknown> {
  return Promise.race([client.next(), new Promise((r) => setTimeout(() => r("nothing"), waitMs))]);
}

// describe.skip, because Bun 1.3.0 ignores { skip } on describe.
(REDIS_URL ? describe : describe.skip)("WebSocket broadcasts through Redis", () => {
  const clients: { close(): Promise<unknown> }[] = [];
  const connectRedis = async () => {
    const client = await createClient({ url: REDIS_URL }).connect();
    clients.push(client);
    return client;
  };
  const instance = async (name = run) => {
    const redis = await connectRedis();
    // As in the docs: a second connection from redis.duplicate(), passed as it is.
    const subscriber = await redis.duplicate().connect();
    clients.push(subscriber);
    return createApp({ name, db: memory(), routes: [watch, post], jobs: [notify], auth: bearer((token) => users.get(token) ?? null), redis, sockets: { transport: "redis", subscriber }, logger: quiet });
  };
  let a: Awaited<ReturnType<typeof instance>>;
  let b: Awaited<ReturnType<typeof instance>>;
  let other: Awaited<ReturnType<typeof instance>>;
  let serverA: { port: number; close(): Promise<void> };
  let serverB: { port: number; close(): Promise<void> };
  let serverOther: { port: number; close(): Promise<void> };
  const sockets: Client[] = [];
  const open = async (port: number, token: string) => {
    const client = await connect(port, token);
    sockets.push(client);
    return client;
  };

  before(async () => {
    [a, b, other] = [await instance(), await instance(), await instance(`${run}-other`)];
    [serverA, serverB, serverOther] = [await a.listen(0, "127.0.0.1"), await b.listen(0, "127.0.0.1"), await other.listen(0, "127.0.0.1")];
  });
  after(async () => {
    for (const client of sockets) client.ws.close();
    await Promise.all([a.close({ timeoutMs: 1000 }), b.close({ timeoutMs: 1000 }), other.close({ timeoutMs: 1000 })]);
    for (const client of clients) await client.close();
  });

  test("a broadcast on one instance reaches the room's sockets on every instance, once", async () => {
    const [onA, onB, elsewhere] = [await open(serverA.port, "ada-token"), await open(serverB.port, "ada-token"), await open(serverOther.port, "ada-token")];
    for (const client of [onA, onB, elsewhere]) await join(client, "board:1");
    const res = await a.request("/rooms/board:1", { method: "POST", json: { text: "from A" }, as: acme });
    assert.equal(res.status, 200);
    assert.deepEqual(await received(onA, 1), [{ type: "note", text: "from A" }]);
    assert.deepEqual(await received(onB, 1), [{ type: "note", text: "from A" }]);
    assert.equal(await quietFor(onA), "nothing", "the sending instance does not get its own broadcast twice");
    assert.equal(await quietFor(elsewhere), "nothing", "another app on the same Redis gets nothing");
  });

  test("rooms stay per tenant across instances", async () => {
    const [ada, cy, dee] = [await open(serverB.port, "ada-token"), await open(serverB.port, "cy-token"), await open(serverB.port, "dee-token")];
    for (const client of [ada, cy, dee]) await join(client, "board:2");
    await a.request("/rooms/board:2", { method: "POST", json: { text: "acme only" }, as: acme });
    await a.sockets.broadcast("board:2", { type: "globex" }, { tenantId: "globex" });
    await a.sockets.broadcast("board:2", { type: "no tenant" });
    assert.deepEqual(await received(ada, 1), [{ type: "note", text: "acme only" }]);
    assert.deepEqual(await received(cy, 1), [{ type: "globex" }]);
    assert.deepEqual(await received(dee, 1), [{ type: "no tenant" }]);
    for (const client of [ada, cy, dee]) assert.equal(await quietFor(client), "nothing");
  });

  test("a job run by a worker without sockets reaches the sockets of the web instances", async () => {
    const worker = await instance();
    const onB = await open(serverB.port, "ada-token");
    await join(onB, "reports");
    await worker.request("/rooms/reports", { method: "POST", json: { text: "ready", later: true }, as: acme });
    await worker.jobs.runDue();
    assert.deepEqual(await received(onB, 1), [{ type: "job", text: "ready" }]);
    await worker.close();
  });

  test("an instance that closed gets no more broadcasts", async () => {
    const c = await instance();
    const serverC = await c.listen(0, "127.0.0.1");
    const onC = await connect(serverC.port, "ada-token");
    await join(onC, "board:3");
    await c.close({ timeoutMs: 1000 });
    // Unsubscribed: publishing reaches the subscribers of a and b only.
    const subscribers = (await (await connectRedis()).sendCommand(["PUBSUB", "NUMSUB", `inferlo:${run}:sockets`])) as [string, number];
    assert.equal(Number(subscribers[1]), 2);
  });
});

describe("createApp({ sockets })", () => {
  const redis: RedisClient = { sendCommand: async () => "OK" };
  const subscriber: RedisSubscriber = { subscribe: async () => {}, unsubscribe: async () => {} };
  const il6036 = (options: Parameters<typeof createApp>[0], pattern: RegExp) =>
    assert.throws(() => createApp({ db: memory(), logger: quiet, ...options }), (e: unknown) => e instanceof InferloError && e.code === "IL6036" && pattern.test(e.message) && /duplicate\(\)/.test(e.fix ?? ""));

  test("checks the transport, redis, name and subscriber", () => {
    il6036({ name: "x", redis, sockets: { transport: "kafka" as never, subscriber } }, /Invalid sockets transport "kafka"/);
    il6036({ name: "x", sockets: { transport: "redis", subscriber } }, /no redis option/);
    il6036({ redis, sockets: { transport: "redis", subscriber } }, /createApp\(\{ name \}\)/);
    il6036({ name: "x", redis, sockets: { transport: "redis" } }, /needs a subscriber/);
    const both = { ...redis, ...subscriber };
    il6036({ name: "x", redis: both, sockets: { transport: "redis", subscriber: both } }, /second Redis client/);
    il6036({ name: "x", redis, sockets: { subscriber } }, /only used with transport "redis"/);
    il6036({ name: "x", redis, sockets: { transport: "redis", subscriber, channel: "x" } as never }, /Unknown sockets option "channel"/);
    il6036({ sockets: "redis" as never }, /must be an object/);
  });

  test("without a transport, broadcasts never touch Redis", async () => {
    const commands: string[][] = [];
    const app = createApp({ name: "x", db: memory(), logger: quiet, redis: { sendCommand: async (args) => void commands.push(args) } });
    await app.sockets.broadcast("room", { a: 1 });
    assert.deepEqual(commands, []);
  });
});
