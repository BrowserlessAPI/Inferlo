import assert from "node:assert/strict";
import { test } from "node:test";
import { createAI, mockProvider, type ProviderRequest } from "../../../src/ai/public.ts";
import { makeHandler, makeRouter } from "../src/app.ts";

const signedIn = { "content-type": "application/json", authorization: "Bearer demo-token" };

function mockAI(respond: (request: ProviderRequest) => ReturnType<Parameters<typeof mockProvider>[0]["respond"]>) {
  return createAI({ providers: { anthropic: mockProvider({ respond }) }, models: { fast: "anthropic:claude-haiku-4-5" } });
}

test("a mutation classifies text with structured output, behind the app's own auth", async () => {
  const handle = makeHandler(mockAI(() => '{"label":"question"}'));
  const body = JSON.stringify({ text: "How do I export?" });
  assert.equal((await handle(new Request("http://localhost/trpc/classify", { method: "POST", headers: { "content-type": "application/json" }, body }))).status, 401);
  const res = await handle(new Request("http://localhost/trpc/classify", { method: "POST", headers: signedIn, body }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { result: { data: { label: "question" } } });
  const invalid = await handle(new Request("http://localhost/trpc/classify", { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) }));
  assert.equal(invalid.status, 400);
});

test("a subscription streams the model's text", async () => {
  const router = makeRouter(mockAI(() => "Streaming works."));
  let text = "";
  for await (const chunk of await router.createCaller({ user: { id: "u1" } }).chat({ prompt: "hi" })) text += chunk;
  assert.equal(text, "Streaming works.");
});

test("the assistant calls the app's procedures as tools for the signed-in user", async () => {
  const ai = mockAI((r) => {
    const results = r.messages.filter((m) => m.role === "tool");
    if (results.length === 0) return { toolCalls: [{ name: "tickets_create", input: { title: "Export fails" } }] };
    if (results.length === 1) return { toolCalls: [{ name: "tickets_list", input: {} }] };
    return `You have ${JSON.parse(results[1]!.content).length} ticket.`;
  });
  const handle = makeHandler(ai);
  const res = await handle(new Request("http://localhost/trpc/assistant", { method: "POST", headers: signedIn, body: JSON.stringify({ message: "My export fails" }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { result: { data: { reply: "You have 1 ticket.", toolCalls: ["tickets_create", "tickets_list"] } } });
  const list = await handle(new Request("http://localhost/trpc/tickets.list", { headers: signedIn }));
  assert.deepEqual((await list.json()).result.data, [{ id: "T-1", title: "Export fails", ownerId: "00000000-0000-4000-8000-000000000001" }]);
});
