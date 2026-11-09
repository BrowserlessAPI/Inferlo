import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("assistant streams text and route tool calls as the signed-in user", async () => {
  const usage: { for?: string; kind: string }[] = [];
  const provider = mockProvider({
    respond: (r) => {
      const names = (r.tools ?? []).map((tool) => tool.name);
      if (!names.includes("createNote") || !names.includes("listNotes")) return "no tools";
      return r.messages.at(-1)!.role === "tool" ? "Saved your note." : { toolCalls: [{ id: "c1", name: "createNote", input: { title: "Buy milk", body: "2 litres" } }] };
    },
  });
  const app = createApp({
    models,
    routes: [notes],
    db: memory(),
    auth: { resolve: () => null },
    ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) },
  });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const res = await app.request("/assistant", { method: "POST", json: { message: "Remember to buy 2 litres of milk" }, as: asA });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const body = await res.text();
  assert.match(body, /event: tool-call\ndata: \{"id":"c1","name":"createNote"/);
  assert.match(body, /event: tool-result\ndata: \{"id":"c1","name":"createNote","status":201,"isError":false\}/);
  assert.match(body, /event: done/);
  const text = [...body.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!)).join("");
  assert.equal(text, "Saved your note.");
  const saved = await app.db.notes.findMany({});
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.ownerId, a.id);
  assert.equal(body.includes(saved[0]!.id), false, "tool output stays on the server");
  assert.equal(usage[0]?.for, a.id);
  assert.equal(usage[0]?.kind, "stream");
  assert.equal((await app.request("/assistant", { method: "POST", json: { message: "" }, as: asA })).status, 422);
  assert.equal((await app.request("/assistant", { method: "POST", json: { message: "hi" } })).status, 401);
});
