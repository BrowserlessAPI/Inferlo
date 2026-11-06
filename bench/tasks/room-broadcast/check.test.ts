import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as live from "../src/routes/live.ts";

type Client = { send(data: unknown): void; next(): Promise<any>; close(): void };

function connect(port: number, token: string): Promise<Client> {
  const WS = WebSocket as unknown as new (url: string, init?: object) => WebSocket;
  const ws = new WS(`ws://127.0.0.1:${port}/live`, { headers: { authorization: `Bearer ${token}` } });
  const queue: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data));
    const resolve = waiting.shift();
    if (resolve) resolve(data);
    else queue.push(data);
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () =>
      resolve({
        send: (data) => ws.send(JSON.stringify(data)),
        next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r))),
        close: () => ws.close(),
      });
    ws.onerror = () => reject(new Error("connection refused"));
  });
}

test("announcements reach the sockets that joined the room, and only admins send them", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*live/, "registers the live routes");
  const admin = { id: "11111111-1111-4111-8111-111111111111", email: "ada@x.io", name: "Ada", roles: ["admin"] };
  const member = { id: "22222222-2222-4222-8222-222222222222", email: "bob@x.io", name: "Bob", roles: ["member"] };
  const app = createApp({
    models,
    db: memory(),
    routes: [live],
    auth: { resolve: (req) => ({ "Bearer ada": admin, "Bearer bob": member })[req.headers.get("authorization") ?? ""] ?? null },
    logger: { info() {}, error() {} },
  });
  const server = await app.listen(0, "127.0.0.1");
  const [lobby, other] = [await connect(server.port, "bob"), await connect(server.port, "bob")];
  try {
    lobby.send({ room: "lobby" });
    assert.deepEqual(await lobby.next(), { watching: "lobby" });
    other.send({ room: "other" });
    assert.deepEqual(await other.next(), { watching: "other" });

    const denied = await app.request("/announcements", { method: "POST", json: { room: "lobby", text: "Hi" }, as: member });
    assert.equal(denied.status, 403, "only admins announce");
    const res = await app.request("/announcements", { method: "POST", json: { room: "lobby", text: "Release at 5pm" }, as: admin });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: true });
    assert.deepEqual(await lobby.next(), { type: "announcement", text: "Release at 5pm" });

    // Messages arrive in order, so had "other" got the announcement, it would come before this answer.
    other.send({ room: "other" });
    assert.deepEqual(await other.next(), { watching: "other" }, "sockets in other rooms get nothing");
  } finally {
    lobby.close();
    other.close();
    await app.close({ timeoutMs: 1000 });
  }
});
