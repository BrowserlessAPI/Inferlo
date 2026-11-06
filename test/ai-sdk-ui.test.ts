import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DefaultChatTransport, readUIMessageStream, type UIMessage } from "ai";
import { createAI, createApp, fromUIMessages, InferloError, mockProvider, ProviderError, route, uiChatBody, type Provider } from "../src/index.ts";

// ai.stream(...).toResponse({ format: "ai-sdk" }) speaks the AI SDK UI message stream protocol (v1), so useChat from
// @ai-sdk/react (through the ai package's DefaultChatTransport) talks to an Inferlo route directly. CI runs this file
// on the oldest supported ai package (5.0.0) and the latest.

const chunks = (...parts: string[]): Provider => ({
  name: "chunks",
  async generate() {
    return { text: parts.join(""), usage: { inputTokens: 1, outputTokens: parts.length } };
  },
  async *stream() {
    for (const p of parts) yield p;
    yield { usage: { inputTokens: 4, outputTokens: parts.length } };
  },
});

const failing: Provider = {
  name: "failing",
  async generate() {
    throw new ProviderError("failing", 400, "down");
  },
  async *stream() {
    yield "Half an ";
    throw new ProviderError("failing", 400, "down");
  },
};

const events = (text: string) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => block.replace(/^data: /, ""))
    .map((data) => (data === "[DONE]" ? data : (JSON.parse(data) as Record<string, unknown>)));

describe("AI SDK UI message streams", () => {
  test("toResponse({ format: \"ai-sdk\" }) sends the UI message stream protocol", async () => {
    const ai = createAI({ providers: { m: chunks("Hello", ", ", "Ada.") }, models: { fast: "m:x" } });
    const res = ai.stream({ model: "fast", prompt: "Hi" }).toResponse({ format: "ai-sdk", headers: { "x-extra": "1" } });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("x-vercel-ai-ui-message-stream"), "v1");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(res.headers.get("x-extra"), "1");
    const list = events(await res.text());
    const id = (list[1] as { id: string }).id;
    assert.deepEqual(list, [
      { type: "start" },
      { type: "text-start", id },
      { type: "text-delta", id, delta: "Hello" },
      { type: "text-delta", id, delta: ", " },
      { type: "text-delta", id, delta: "Ada." },
      { type: "text-end", id },
      { type: "finish" },
      "[DONE]",
    ]);
  });

  test("the default format is unchanged", async () => {
    const ai = createAI({ providers: { m: chunks("a") }, models: { fast: "m:x" } });
    const res = ai.stream({ model: "fast", prompt: "Hi" }).toResponse();
    assert.equal(res.headers.get("x-vercel-ai-ui-message-stream"), null);
    assert.match(await res.text(), /^event: text\ndata: "a"\n\nevent: done\n/);
  });

  test("an unknown format raises IL5027", () => {
    const ai = createAI({ providers: { m: chunks("a") }, models: { fast: "m:x" } });
    assert.throws(
      () => ai.stream({ model: "fast", prompt: "Hi" }).toResponse({ format: "vercel" as "ai-sdk" }),
      (e: unknown) => e instanceof InferloError && e.code === "IL5027",
    );
  });

  test("a failure after the first chunk sends an error chunk with the code only", async () => {
    const ai = createAI({ providers: { m: failing }, models: { fast: "m:x" } });
    const original = console.error;
    console.error = () => {};
    try {
      const list = events(await ai.stream({ model: "fast", prompt: "Hi" }).toResponse({ format: "ai-sdk" }).text());
      const id = (list[1] as { id: string }).id;
      assert.deepEqual(list.slice(0, 3), [{ type: "start" }, { type: "text-start", id }, { type: "text-delta", id, delta: "Half an " }]);
      assert.deepEqual(list.slice(3), [{ type: "error", errorText: "The model call failed (IL5006)." }, "[DONE]"]);
    } finally {
      console.error = original;
    }
  });

  test("fromUIMessages turns UI messages into model messages: text parts joined, other parts left out", () => {
    const messages = fromUIMessages([
      { role: "system", parts: [{ type: "text", text: "Be brief." }] },
      { role: "user", parts: [{ type: "text", text: "Hi " }, { type: "file" }, { type: "text", text: "there" }] },
      { role: "assistant", parts: [{ type: "step-start" }, { type: "text", text: "Hello!" }, { type: "reasoning", text: "thinking" }] },
      { role: "assistant", parts: [{ type: "step-start" }] },
    ]);
    assert.deepEqual(messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi there" },
      { role: "assistant", content: "Hello!" },
    ]);
  });

  test("uiChatBody accepts the body useChat sends and rejects bad ones", () => {
    const body = {
      id: "chat-1",
      trigger: "submit-message",
      messageId: undefined,
      messages: [{ id: "m1", role: "user", metadata: { at: 1 }, parts: [{ type: "text", text: "Hi", state: "done" }] }],
    };
    const parsed = uiChatBody.parse(body);
    assert.deepEqual(parsed.messages, [{ role: "user", parts: [{ type: "text", text: "Hi" }] }]);
    assert.throws(() => uiChatBody.parse({ messages: [] }));
    assert.throws(() => uiChatBody.parse({ messages: [{ role: "tool", parts: [] }] }));
    assert.throws(() => uiChatBody.parse({ messages: [{ role: "user", parts: [{ type: "text", text: "x".repeat(100_001) }] }] }));
  });

  test("useChat's transport (DefaultChatTransport from the ai package) reads an Inferlo route's answer", async () => {
    const seen: string[][] = [];
    const chat = route.post("/chat", { auth: "public", body: uiChatBody }).handle(({ body, ai }) => {
      const messages = fromUIMessages(body.messages);
      seen.push(messages.map((m) => `${m.role}: ${m.content}`));
      return ai.stream({ model: "fast", messages }).toResponse({ format: "ai-sdk" });
    });
    const app = createApp({
      routes: [{ chat }],
      ai: { providers: { mock: mockProvider({ respond: () => "Inferlo streams this." }) }, models: { fast: "mock:m" } },
      logging: { requests: false },
    });
    const transport = new DefaultChatTransport<UIMessage>({
      api: "http://inferlo.test/chat",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch,
    });
    const history: UIMessage[] = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "What do you do?" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "I answer." }] },
      { id: "m3", role: "user", parts: [{ type: "text", text: "Stream something." }] },
    ];
    const stream = await transport.sendMessages({ chatId: "chat-1", messages: history, trigger: "submit-message", messageId: undefined, abortSignal: undefined });
    let last: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) last = message;
    assert.equal(last?.role, "assistant");
    const text = last!.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
    assert.equal(text, "Inferlo streams this.");
    assert.deepEqual(seen, [["user: What do you do?", "assistant: I answer.", "user: Stream something."]]);
  });
});
