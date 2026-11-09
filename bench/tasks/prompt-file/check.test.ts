import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp, memory, mockProvider, parsePromptFile } from "@browserlessapi/inferlo";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as notes from "../src/routes/notes.ts";
import * as prompts from "../src/prompts/index.ts";

test("the summary prompt is a versioned prompt file used by the route", async () => {
  const file = parsePromptFile(readFileSync(new URL("../src/prompts/summarize-note.md", import.meta.url), "utf8"), "summarize-note.md");
  assert.equal(file.version, "1");
  assert.deepEqual(Object.keys(file.variables).sort(), ["body", "title"]);
  assert.ok(file.system, "has a system message");
  const generated = (prompts as Record<string, { id?: string }>).summarizeNote;
  assert.equal(generated?.id, "summarize-note@1", "src/prompts/index.ts was generated from the file");

  const usage: { prompt?: string; for?: string }[] = [];
  const seen: string[] = [];
  const provider = mockProvider({
    respond: (r) => {
      seen.push(r.messages.map((m) => m.content).join("\n"));
      return JSON.stringify({ summary: "Milk." });
    },
  });
  const app = createApp({ models, routes: [notes], db: memory(), auth: { resolve: () => null }, ai: { providers: { mock: provider }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) } });
  const a = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const asA = { id: a.id, email: a.email, name: a.name, roles: [] };
  const note = await app.db.notes.insert({ title: "Shopping", body: "Buy 2 litres of milk", ownerId: a.id });
  const out = await readJson(await app.request(`/notes/${note.id}/summary`, { method: "POST", as: asA }), 200);
  assert.deepEqual(out, { summary: "Milk." });
  assert.equal(usage[0]?.prompt, "summarize-note@1");
  assert.equal(usage[0]?.for, a.id);
  assert.match(seen[0]!, /Shopping/);
  assert.match(seen[0]!, /Buy 2 litres of milk/);
});
