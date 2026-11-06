// WebSocket routes (route.ws): auth, origin checks, validation, rate limits, ordering, closing and shutdown, on a
// real server from app.listen() (Node.js, Bun and Deno), and the RFC 6455 frame reader used on Node.js.
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { bearer, createApp, InferloError, memory, model, route, t, type Socket } from "../src/index.ts";
import { encodeClose, encodeFrame, FrameReader, OP_BINARY, OP_CONTINUATION, OP_PING, OP_TEXT } from "../src/websocket.ts";

const quiet = { info: () => {}, error: () => {} };
const users = new Map([
  ["ada-token", { id: "ada", roles: ["member"] }],
  ["bob-token", { id: "bob", roles: [] as string[] }],
]);
const auth = bearer((token) => users.get(token) ?? null);
const Message = model("ws_messages", { room: t.string(), text: t.string().max(200), author: t.string() });
type MessagesTable = { insert(v: { room: string; text: string; author: string }): Promise<{ text: string; author: string }>; count(): Promise<number> };
const messages = (db: unknown) => (db as Record<string, MessagesTable>)[Message.name]!;

const echo = route
  .ws("/echo/:room", { message: t.object({ text: t.string().min(1).max(200) }), params: t.object({ room: t.string().max(20) }) })
  .handle(async ({ message, params, user, db }) => {
    const saved = await messages(db).insert({ room: params.room, text: message.text, author: user.id });
    return { room: params.room, text: saved.text, author: saved.author };
  });
const members = route.ws("/members", { auth: "member" }).handle(() => ({ ok: true }));
const open = route.ws("/open", { auth: "public" }).handle(({ user }) => ({ user: user?.id ?? null }));
const limited = route.ws("/limited", { rateLimit: { max: 3, per: "minute", by: "user" } }).handle(({ message }) => ({ got: message }));
const sockets: Socket[] = [];
let slowDone = false;
const control = route
  .ws("/control", { message: t.object({ action: t.enum(["stream", "close", "bad-close", "fail", "slow"]) }) })
  .handle(async ({ message, socket, signal }) => {
    sockets.push(socket);
    if (message.action === "stream") {
      for (const n of [1, 2, 3]) socket.send({ n });
      return { done: true };
    }
    if (message.action === "close") return socket.close(4000, "bye");
    if (message.action === "bad-close") return socket.close(1001);
    if (message.action === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 150));
      slowDone = signal.aborted;
      return { slow: true };
    }
    throw new Error("secret detail");
  });

function makeApp(options: { maxBodySize?: number; cors?: { origin: string[] } } = {}) {
  return createApp({ models: [Message], db: memory(), routes: [{ echo, members, open, limited, control }], auth, logger: quiet, ...options });
}

type Client = { ws: WebSocket; next(): Promise<any>; closed: Promise<{ code: number; reason: string }> };
function connect(port: number, path: string, token?: string): Promise<Client> {
  const WS = WebSocket as unknown as new (url: string, init?: object) => WebSocket;
  const ws = new WS(`ws://127.0.0.1:${port}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  const queue: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    const resolve = waiting.shift();
    if (resolve) resolve(data);
    else queue.push(data);
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => (ws.onclose = (event) => resolve({ code: event.code, reason: event.reason })));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, closed, next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r))) });
    ws.onerror = () => reject(new Error("connection refused"));
  });
}

/**
 * A minimal client on a raw TCP socket: sends the handshake and one masked text message, and resolves with the code
 * and reason of the server's close frame. It reads the frame itself, because some WebSocket clients (Bun 1.3.0's)
 * report every close code from the server as 1000.
 */
function serverClose(port: number, path: string, token: string, message: string, onOpen: () => void): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let buffer = new Uint8Array(0);
    let open = false;
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer ${token}\r\n\r\n`);
    });
    socket.on("data", (chunk: Uint8Array) => {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      buffer = joined;
      if (!open) {
        const end = Buffer.from(buffer).indexOf("\r\n\r\n");
        if (end === -1) return;
        if (!Buffer.from(buffer.subarray(0, end)).toString().startsWith("HTTP/1.1 101")) return reject(new Error("not upgraded"));
        buffer = buffer.subarray(end + 4);
        open = true;
        const payload = new TextEncoder().encode(message);
        const frame = new Uint8Array(6 + payload.length);
        frame[0] = 0x81;
        frame[1] = 0x80 | payload.length;
        frame.set([9, 8, 7, 6], 2);
        payload.forEach((byte, i) => (frame[6 + i] = byte ^ [9, 8, 7, 6][i & 3]!));
        socket.write(frame);
        onOpen();
      }
      // Skip data frames until the close frame (opcode 8); payloads here are short (under 126 bytes).
      while (buffer.length >= 2) {
        const length = buffer[1]! & 0x7f;
        if (buffer.length < 2 + length) return;
        if ((buffer[0]! & 0x0f) === 0x8) {
          socket.destroy();
          return resolve({ code: (buffer[2]! << 8) | buffer[3]!, reason: new TextDecoder().decode(buffer.subarray(4, 2 + length)) });
        }
        buffer = buffer.subarray(2 + length);
      }
    });
  });
}

const upgradeHeaders = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };

describe("route.ws without a server", () => {
  const app = makeApp();
  test("a plain GET gets 426 IL2010 with Upgrade: websocket", async () => {
    const res = await app.request("/members", { as: { id: "ada", roles: ["member"] } });
    assert.equal(res.status, 426);
    assert.equal(res.headers.get("upgrade"), "websocket");
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL2010");
  });
  test("auth, roles and the handshake are checked before the upgrade", async () => {
    assert.equal((await app.request("/members", { headers: upgradeHeaders })).status, 401);
    assert.equal((await app.request("/members", { headers: upgradeHeaders, as: { id: "bob", roles: [] } })).status, 403);
    const bad = await app.request("/members", { headers: { ...upgradeHeaders, "sec-websocket-key": "short" }, as: { id: "ada", roles: ["member"] } });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get("sec-websocket-version"), "13");
  });
  test("a host that cannot upgrade answers 501 IL2011", async () => {
    const res = await app.request("/members", { headers: upgradeHeaders, as: { id: "ada", roles: ["member"] } });
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL2011");
  });
  test("only the app's own origin and the cors origins may connect (403 IL3006)", async () => {
    const as = { id: "ada", roles: ["member"] };
    const evil = await app.request("/members", { headers: { ...upgradeHeaders, origin: "https://evil.example" }, as });
    assert.equal(evil.status, 403);
    assert.equal(((await evil.json()) as { error: { code: string } }).error.code, "IL3006");
    // Same host: past the origin check (501 here, as app.request cannot upgrade).
    assert.equal((await app.request("/members", { headers: { ...upgradeHeaders, origin: "http://inferlo.test" }, as })).status, 501);
    const withCors = makeApp({ cors: { origin: ["https://app.example"] } });
    assert.equal((await withCors.request("/members", { headers: { ...upgradeHeaders, origin: "https://app.example" }, as })).status, 501);
    assert.equal((await withCors.request("/members", { headers: { ...upgradeHeaders, origin: "https://evil.example" }, as })).status, 403);
  });
  test("describe marks WebSocket routes, OpenAPI leaves them out", () => {
    const described = app.describe().routes.find((r) => r.path === "/echo/:room")!;
    assert.equal(described.method, "GET");
    assert.equal(described.websocket, true);
    assert.deepEqual(Object.keys((described.message as { properties: object }).properties), ["text"]);
    assert.equal((app.openapi().paths as Record<string, unknown>)["/echo/{room}"], undefined);
  });
  test("a message option that is not a schema raises IL6035", () => {
    const bad = route.ws("/bad", { auth: "public", message: { text: "string" } as never }).handle(() => null);
    assert.throws(() => createApp({ routes: [bad] }), (e: InferloError) => e.code === "IL6035");
  });
  test("a WebSocket route and a GET route on one path are duplicates (IL6001)", () => {
    const get = route.get("/members", { auth: "public" }).handle(() => null);
    assert.throws(() => createApp({ routes: [{ members, get }], auth }), (e: InferloError) => e.code === "IL6001");
  });
});

describe("route.ws on a server from app.listen()", () => {
  let app: ReturnType<typeof makeApp>;
  let server: { port: number; close(): Promise<void> };
  before(async () => {
    app = makeApp();
    server = await app.listen(0, "127.0.0.1");
  });
  after(async () => {
    await app.close({ timeoutMs: 2000 });
  });

  test("messages are validated and answered, in order, with ctx.db, params and the user", async () => {
    const c = await connect(server.port, "/echo/lobby", "ada-token");
    c.ws.send(JSON.stringify({ text: "one" }));
    c.ws.send(JSON.stringify({ text: "two" }));
    assert.deepEqual(await c.next(), { room: "lobby", text: "one", author: "ada" });
    assert.deepEqual(await c.next(), { room: "lobby", text: "two", author: "ada" });
    c.ws.send(JSON.stringify({ text: "" }));
    const invalid = await c.next();
    assert.equal(invalid.error.code, "IL1001");
    c.ws.send("not json");
    assert.equal((await c.next()).error.code, "IL2003");
    // The socket stays open after errors.
    c.ws.send(JSON.stringify({ text: "three" }));
    assert.equal((await c.next()).text, "three");
    assert.equal(await messages(app.db).count(), 3);
    c.ws.close();
    await c.closed;
  });

  test("a socket that may not connect is refused, and public routes take anyone", async () => {
    await assert.rejects(() => connect(server.port, "/echo/lobby"));
    await assert.rejects(() => connect(server.port, "/members", "bob-token"));
    const anon = await connect(server.port, "/open");
    anon.ws.send("{}");
    assert.deepEqual(await anon.next(), { user: null });
    anon.ws.close();
    // Plain HTTP on a WebSocket route: 426.
    const res = await fetch(`http://127.0.0.1:${server.port}/open`);
    assert.equal(res.status, 426);
  });

  test("rateLimit counts the connection and every message", async () => {
    const c = await connect(server.port, "/limited", "ada-token");
    c.ws.send("1");
    c.ws.send("2");
    c.ws.send("3");
    assert.deepEqual(await c.next(), { got: 1 });
    assert.deepEqual(await c.next(), { got: 2 });
    assert.equal((await c.next()).error.code, "IL2005");
    c.ws.close();
    await c.closed;
    await assert.rejects(() => connect(server.port, "/limited", "ada-token"), "a new connection is refused too");
  });

  test("ctx.socket sends several messages and closes with an application code", async () => {
    const c = await connect(server.port, "/control", "ada-token");
    c.ws.send(JSON.stringify({ action: "stream" }));
    assert.deepEqual([await c.next(), await c.next(), await c.next(), await c.next()], [{ n: 1 }, { n: 2 }, { n: 3 }, { done: true }]);
    c.ws.send(JSON.stringify({ action: "bad-close" }));
    assert.equal((await c.next()).error.code, "IL2012");
    c.ws.send(JSON.stringify({ action: "fail" }));
    const failed = await c.next();
    assert.deepEqual([failed.error.code, failed.error.message], ["IL9000", "Internal server error"]);
    c.ws.send(JSON.stringify({ action: "close" }));
    assert.deepEqual(await c.closed, { code: 4000, reason: "bye" });
    // Sending on a closed socket does nothing.
    sockets.at(-1)!.send({ late: true });
  });

  test("binary messages close the socket with 1003", async () => {
    const c = await connect(server.port, "/open");
    c.ws.send(new Uint8Array([1, 2, 3]));
    assert.equal((await c.closed).code, 1003);
  });

  test("app.close() lets the running message finish, then closes open sockets with 1001", async () => {
    let closing: Promise<void> | undefined;
    const closed = serverClose(server.port, "/control", "ada-token", JSON.stringify({ action: "slow" }), () => {
      setTimeout(() => (closing = app.close({ timeoutMs: 2000 })), 30);
    });
    assert.deepEqual(await closed, { code: 1001, reason: "Server shutting down" });
    await closing;
    assert.equal(slowDone, true, "the message finished, with ctx.signal aborted by the close");
  });
});

describe("route.ws message size", () => {
  test("a message larger than maxBodySize closes the socket with 1009", async () => {
    const app = makeApp({ maxBodySize: 1000 });
    const server = await app.listen(0, "127.0.0.1");
    try {
      const c = await connect(server.port, "/open");
      c.ws.send(JSON.stringify({ text: "x".repeat(2000) }));
      assert.equal((await c.closed).code, 1009);
    } finally {
      await app.close({ timeoutMs: 2000 });
    }
  });
});

describe("FrameReader (RFC 6455 client frames)", () => {
  const mask = (opcode: number, payload: Uint8Array, fin = true): Uint8Array => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const length = payload.byteLength;
    const head = length < 126 ? [length | 0x80] : length < 65536 ? [126 | 0x80, length >> 8, length & 0xff] : [127 | 0x80, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff];
    const out = new Uint8Array(1 + head.length + 4 + length);
    out[0] = (fin ? 0x80 : 0) | opcode;
    out.set(head, 1);
    out.set(key, 1 + head.length);
    for (let i = 0; i < length; i++) out[1 + head.length + 4 + i] = payload[i]! ^ key[i & 3]!;
    return out;
  };
  const text = (s: string) => new TextEncoder().encode(s);
  const read = (max = 1 << 20) => {
    const events: unknown[] = [];
    const reader = new FrameReader(max, {
      message: (data) => events.push(["message", typeof data === "string" ? data : [...data]]),
      ping: (payload) => events.push(["ping", new TextDecoder().decode(payload)]),
      close: (code, reason) => events.push(["close", code, reason]),
      error: (code, reason) => events.push(["error", code, reason]),
    });
    return { reader, events };
  };

  test("reads text, binary, long and fragmented messages, byte by byte too", () => {
    const { reader, events } = read();
    const long = "y".repeat(70_000);
    const all = [mask(OP_TEXT, text("hi")), mask(OP_BINARY, new Uint8Array([7, 8])), mask(OP_TEXT, text(long)), mask(OP_TEXT, text("frag"), false), mask(OP_PING, text("p")), mask(OP_CONTINUATION, text("ment"))];
    for (const frame of all.slice(0, 2)) for (const byte of frame) reader.push(new Uint8Array([byte]));
    for (const frame of all.slice(2)) reader.push(frame);
    assert.deepEqual(events, [["message", "hi"], ["message", [7, 8]], ["message", long], ["ping", "p"], ["message", "fragment"]]);
  });

  test("close frames, and protocol errors with their close codes", () => {
    const closing = read();
    closing.reader.push(mask(0x8, new Uint8Array([0x0f, 0xa0, ...text("done")])));
    assert.deepEqual(closing.events, [["close", 4000, "done"]]);
    const cases: [Uint8Array, number][] = [
      [encodeFrame(OP_TEXT, text("unmasked")), 1002],
      [mask(OP_CONTINUATION, text("x")), 1002],
      [mask(0x3, text("x")), 1002],
      [mask(OP_PING, text("x"), false), 1002],
      [mask(OP_TEXT, new Uint8Array([0xff, 0xfe])), 1007],
      [mask(OP_TEXT, text("x".repeat(200))), 1009],
    ];
    for (const [frame, code] of cases) {
      const { reader, events } = read(100);
      reader.push(frame);
      assert.equal((events[0] as [string, number])[1], code, `close code ${code}`);
      assert.equal((events[0] as [string])[0], "error");
    }
  });

  test("server frames: lengths up to 64-bit and close frames with a code", () => {
    assert.deepEqual([...encodeFrame(OP_TEXT, text("ok"))], [0x81, 2, 0x6f, 0x6b]);
    assert.deepEqual([...encodeFrame(OP_TEXT, new Uint8Array(300)).subarray(0, 4)], [0x81, 126, 1, 44]);
    assert.deepEqual([...encodeFrame(OP_TEXT, new Uint8Array(70_000)).subarray(0, 10)], [0x81, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]);
    assert.deepEqual([...encodeClose(1000, "")], [0x88, 2, 0x03, 0xe8]);
  });
});
