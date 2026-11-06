import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, memory, mockProvider } from "@browserlessapi/inferlo";
import { models } from "../src/models.ts";

test("POST /chat streams a useChat answer for signed-in users", async () => {
  const routes = await import("../src/routes/chat.ts");
  const usage: { for?: string }[] = [];
  const prompts: string[] = [];
  const app = createApp({
    models,
    routes: [routes],
    db: memory(),
    auth: { resolve: () => null },
    ai: {
      providers: { mock: mockProvider({ respond: (req) => (prompts.push(req.messages.map((m) => m.content).join(" | ")), "Hello from Inferlo.") }) },
      models: { fast: "mock:m" },
      onUsage: (u) => void usage.push(u),
    },
  });
  const user = await app.db.users.insert({ email: "a@x.io", name: "A" });
  const as = { id: user.id, email: user.email, name: user.name, roles: [] };
  // The body useChat sends.
  const json = {
    id: "chat-1",
    trigger: "submit-message",
    messages: [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "Hello!", state: "done" }] },
      { id: "m3", role: "user", parts: [{ type: "text", text: "What is Inferlo?" }] },
    ],
  };
  assert.equal((await app.request("/chat", { method: "POST", json, as: null })).status, 401);
  const res = await app.request("/chat", { method: "POST", json, as });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-vercel-ai-ui-message-stream"), "v1", "useChat needs the UI message stream protocol");
  const chunks = (await res.text())
    .split("\n\n")
    .filter((b) => b.startsWith("data: ") && b !== "data: [DONE]")
    .map((b) => JSON.parse(b.slice(6)) as { type: string; delta?: string });
  assert.equal(chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join(""), "Hello from Inferlo.");
  assert.ok(chunks.some((c) => c.type === "finish"));
  assert.ok(prompts[0]?.includes("What is Inferlo?") && prompts[0].includes("Hello!"), "the whole conversation reaches the model");
  assert.equal(usage[0]?.for, user.id);
});
