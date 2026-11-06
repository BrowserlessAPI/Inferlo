import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as live from "../src/routes/live.ts";

type Client = { ws: WebSocket; next(): Promise<any> };
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
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiting.push(r))) });
    ws.onerror = () => reject(new Error("connection refused"));
  });
}

test("notes are edited live over a WebSocket, only by their owner", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*live/, "registers the live routes");
  const routes = Object.values(live) as { websocket?: boolean; path: string; options: { rateLimit?: { max: number; per: string } } }[];
  const def = routes.find((r) => r.websocket);
  assert.ok(def, "liveNote is a WebSocket route made with route.ws");
  assert.equal(def.path, "/notes/:id/live");
  assert.deepEqual([def.options.rateLimit?.max, def.options.rateLimit?.per], [120, "minute"]);

  const db = memory();
  const tokens = new Map<string, { id: string; email: string; name: string; roles: string[] }>();
  const app = createApp({ models, db, routes: [live], auth: { resolve: (req) => tokens.get(req.headers.get("authorization")?.slice(7) ?? "") ?? null }, logger: { info() {}, error() {} } });
  const ada = await app.db.users.insert({ email: "ada@x.io", name: "Ada" });
  const bob = await app.db.users.insert({ email: "bob@x.io", name: "Bob" });
  tokens.set("ada", { id: ada.id, email: ada.email, name: ada.name, roles: [] });
  tokens.set("bob", { id: bob.id, email: bob.email, name: bob.name, roles: [] });
  const note = await app.db.notes.insert({ title: "Plan", body: "", ownerId: ada.id });
  const server = await app.listen(0, "127.0.0.1");
  try {
    await assert.rejects(() => connect(server.port, `/notes/${note.id}/live`), "needs a signed-in user");
    const c = await connect(server.port, `/notes/${note.id}/live`, "ada");
    c.ws.send(JSON.stringify({ body: "first draft" }));
    const updated = await c.next();
    assert.equal(updated.id, note.id);
    assert.equal(updated.body, "first draft");
    assert.equal((await app.db.notes.get(note.id)).body, "first draft");
    c.ws.send(JSON.stringify({ body: 42 }));
    assert.equal((await c.next()).error.code, "IL1001", "messages are validated");
    c.ws.close();

    const other = await connect(server.port, `/notes/${note.id}/live`, "bob");
    other.ws.send(JSON.stringify({ body: "hijack" }));
    const denied = await other.next();
    assert.equal(denied.error.code, "IL4001");
    assert.equal((await app.db.notes.get(note.id)).body, "first draft");
    other.ws.close();
  } finally {
    await app.close({ timeoutMs: 1000 });
  }
});
