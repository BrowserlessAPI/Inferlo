import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the tRPC router uses ctx.ai from inferloAI() and offers notes.add to the model as a tool", async () => {
  const source = readFileSync(new URL("../src/trpc.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/trpc/, "uses the tRPC entry point");
  assert.match(source, /inferloAI\(/, "uses the inferloAI() middleware");
  assert.match(source, /trpcTools\(/, "makes tools with trpcTools()");

  process.env.ANTHROPIC_API_KEY = "test-key";
  const requests: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, init);
    const body = JSON.parse(String(init!.body));
    requests.push(body);
    const usage = { input_tokens: 5, output_tokens: 2 };
    if (requests.length === 1) {
      return Response.json({ content: [{ type: "tool_use", id: "call_1", name: "notes_add", input: { text: "Buy milk" } }], stop_reason: "tool_use", usage });
    }
    return Response.json({ content: [{ type: "text", text: "Saved your note." }], stop_reason: "end_turn", usage });
  }) as typeof fetch;

  const { appRouter, notes } = await import("../src/trpc.ts");
  const caller = (appRouter as any).createCaller({});
  assert.deepEqual(await caller.notes.add({ text: "First" }), { count: 1 });
  await assert.rejects(caller.notes.add({ text: "" }), "empty notes are rejected");

  const result = await caller.assistant({ message: "Remember to buy milk" });
  assert.deepEqual(result, { reply: "Saved your note." });
  assert.deepEqual(notes, ["First", "Buy milk"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "claude-haiku-4-5");
  assert.match(JSON.stringify(requests[0].messages), /Remember to buy milk/);
  const tool = requests[0].tools.find((x: { name: string }) => x.name === "notes_add");
  assert.ok(tool, "notes.add is offered as the notes_add tool");
  assert.deepEqual(tool.input_schema.required, ["text"]);
});
