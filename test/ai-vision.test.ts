import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { anthropic, createAI, gemini, InferloError, mockProvider, ollama, openai, openaiCompatible, type Provider } from "../src/index.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A fetch that records request bodies and answers like the provider would. */
function recorder(reply: unknown) {
  const bodies: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { bodies, fetch };
}
const chatReply = { choices: [{ message: { content: "A cat." } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
const anthropicReply = { content: [{ type: "text", text: "A cat." }], usage: { input_tokens: 10, output_tokens: 2 } };

function aiWith(name: string, provider: Provider) {
  return createAI({ providers: { [name]: provider }, models: { vision: `${name}:m` } });
}

describe("vision input", () => {
  test("OpenAI: prompt with a URL and base64 image becomes text and image_url parts", async () => {
    const { bodies, fetch } = recorder(chatReply);
    const ai = aiWith("openai", openai({ apiKey: "k", fetch }));
    const r = await ai.generate({
      model: "vision",
      system: "Be brief.",
      prompt: "What is in these images?",
      images: [{ url: "https://example.com/cat.jpg" }, { base64: PNG, mediaType: "image/png" }],
    });
    assert.equal(r.text, "A cat.");
    assert.deepEqual(bodies[0].messages, [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in these images?" },
          { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      },
    ]);
  });

  test("Gemini, Ollama and OpenAI-compatible providers use the same image_url parts", async () => {
    for (const make of [
      (fetch: typeof globalThis.fetch) => gemini({ apiKey: "k", fetch }),
      (fetch: typeof globalThis.fetch) => ollama({ fetch }),
      (fetch: typeof globalThis.fetch) => openaiCompatible({ name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: "k", fetch }),
    ]) {
      const { bodies, fetch } = recorder(chatReply);
      const provider = make(fetch);
      await aiWith(provider.name, provider).generate({ model: "vision", prompt: "Describe", images: [{ base64: PNG, mediaType: "image/png" }] });
      assert.deepEqual(bodies[0].messages[0].content[1], { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }, provider.name);
    }
  });

  test("Anthropic: images come first as url or base64 sources, data: URLs become base64", async () => {
    const { bodies, fetch } = recorder(anthropicReply);
    const ai = aiWith("anthropic", anthropic({ apiKey: "k", fetch }));
    await ai.generate({
      model: "vision",
      prompt: "Compare",
      images: [{ url: "https://example.com/a.jpg" }, { base64: PNG, mediaType: "image/png" }, { url: `data:image/webp;base64,${PNG}` }],
    });
    assert.deepEqual(bodies[0].messages, [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://example.com/a.jpg" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          { type: "image", source: { type: "base64", media_type: "image/webp", data: PNG } },
          { type: "text", text: "Compare" },
        ],
      },
    ]);
  });

  test("images on user messages in a conversation; messages without images are unchanged", async () => {
    const { bodies, fetch } = recorder(anthropicReply);
    const ai = aiWith("anthropic", anthropic({ apiKey: "k", fetch }));
    await ai.generate({
      model: "vision",
      messages: [
        { role: "user", content: "Here is a receipt", images: [{ url: "https://example.com/r.png" }] },
        { role: "assistant", content: "I see it." },
        { role: "user", content: "What is the total?" },
      ],
    });
    assert.equal(bodies[0].messages[0].content[0].type, "image");
    assert.equal(bodies[0].messages[1].content, "I see it.");
    assert.equal(bodies[0].messages[2].content, "What is the total?");
  });

  test("streaming sends images too, and mockProvider sees them", async () => {
    const mock = mockProvider({ respond: (r) => `${r.messages.at(-1)!.images?.length} image` });
    const ai = createAI({ providers: { mock }, models: { vision: "mock:m" } });
    const text = await ai.stream({ model: "vision", prompt: "Look", images: [{ url: "https://example.com/x.gif" }] }).text();
    assert.equal(text, "1 image");
    assert.deepEqual(mock.calls[0]!.messages.at(-1)!.images, [{ url: "https://example.com/x.gif" }]);
  });

  test("invalid images raise IL5012 before any provider call", async () => {
    const mock = mockProvider({ respond: () => "x" });
    const ai = createAI({ providers: { mock }, models: { vision: "mock:m" } });
    const cases: [unknown, RegExp][] = [
      [{ prompt: "x", images: [{ url: "ftp://example.com/a.png" }] }, /must start with https/],
      [{ prompt: "x", images: [{ url: "file:///etc/passwd" }] }, /must start with https/],
      [{ prompt: "x", images: [{ base64: PNG }] }, /mediaType must be one of/],
      [{ prompt: "x", images: [{ base64: PNG, mediaType: "image/svg+xml" }] }, /mediaType must be one of/],
      [{ prompt: "x", images: [{ base64: "not base64!", mediaType: "image/png" }] }, /not valid base64/],
      [{ prompt: "x", images: [{ url: `data:image/svg+xml;base64,${PNG}` }] }, /media type "image\/svg\+xml"/],
      [{ prompt: "x", images: [{ url: "data:image/png,raw" }] }, /without base64 data/],
      [{ prompt: "x", images: [{ path: "a.png" }] }, /neither url nor base64/],
      [{ prompt: "x", images: "https://example.com/a.png" }, /must be an array/],
      [{ images: [{ url: "https://example.com/a.png" }], messages: [{ role: "user", content: "x" }] }, /needs a prompt/],
      [{ messages: [{ role: "assistant", content: "x", images: [{ url: "https://example.com/a.png" }] }, { role: "user", content: "y" }] }, /only user messages/],
    ];
    for (const [options, message] of cases) {
      await assert.rejects(
        ai.generate({ model: "vision", ...(options as object) } as never),
        (e: unknown) => e instanceof InferloError && e.code === "IL5012" && message.test(e.message) && !!e.fix,
        String(message),
      );
    }
    assert.equal(mock.calls.length, 0);
  });
});
