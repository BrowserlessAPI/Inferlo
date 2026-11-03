import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";

test("assistant creates notes through route tools as the signed-in user", async () => {
  const usage: { for?: string }[] = [];
  const provider = mockProvider({
    respond: (r) => {
      const names = (r.tools ?? []).map((tool) => tool.name);
      if (!names.includes("createNote") || !names.includes("listNotes")) return "no tools";
      return r.messages.at(-1)!.role === "tool" ? "Saved your note." : { toolCalls: [{ name: "createNote", input: { title: "Buy milk", body: "2 litres" } }] };
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
  const out = await readJson(await app.request("/assistant", { method: "POST", json: { message: "Remember to buy 2 litres of milk" }, as: asA }), 200);
  assert.deepEqual(out, { reply: "Saved your note." });
  const saved = await app.db.notes.findMany({});
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.title, "Buy milk");
  assert.equal(saved[0]!.ownerId, a.id);
  assert.equal(usage[0]?.for, a.id);
  assert.equal((await app.request("/assistant", { method: "POST", json: { message: "" }, as: asA })).status, 422);
  assert.equal((await app.request("/assistant", { method: "POST", json: { message: "hi" } })).status, 401);
});
