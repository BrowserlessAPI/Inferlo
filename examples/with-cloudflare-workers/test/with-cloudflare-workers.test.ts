import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { workerModules } from "../../../test/workerd.ts";

// Runs src/index.ts in workerd (the Cloudflare Workers runtime) through Miniflare, with the settings of wrangler.jsonc.
const isBun = "Bun" in globalThis;
const token = "test-token-0123456789";

// Miniflare runs workerd from Node.js. describe.skip, because Bun 1.3.0 ignores the skip option of describe.
(isBun ? describe.skip : describe)("with-cloudflare-workers", () => {
  type Mf = { dispatchFetch(url: string, init?: RequestInit): Promise<Response>; dispose(): Promise<void> };
  let mf: Mf;
  const anthropicCalls: { url: string; key: string | null }[] = [];

  before(async () => {
    const { Miniflare } = await import("miniflare");
    mf = new Miniflare({
      modules: workerModules(new URL("../src/index.ts", import.meta.url).pathname, new URL("../../..", import.meta.url).pathname),
      compatibilityDate: "2025-04-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { API_TOKEN: token, ANTHROPIC_API_KEY: "sk-ant-test" },
      // Calls to the Anthropic API answer here instead of the network.
      outboundService: async (request: Request) => {
        anthropicCalls.push({ url: request.url, key: request.headers.get("x-api-key") });
        const body = (await request.json()) as { stream?: boolean };
        if (body.stream) {
          const events = [
            { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
            { type: "content_block_delta", delta: { type: "text_delta", text: "Streamed " } },
            { type: "content_block_delta", delta: { type: "text_delta", text: "answer." } },
            { type: "message_delta", usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ];
          return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
        }
        return Response.json({ model: "claude-haiku-4-5", content: [{ type: "text", text: "One sentence." }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 3 } });
      },
    }) as unknown as Mf;
  });
  after(async () => {
    await mf?.dispose();
  });

  test("public and private routes", async () => {
    assert.deepEqual(await (await mf.dispatchFetch("https://worker.example.com/status")).json(), { ok: true });
    assert.equal((await mf.dispatchFetch("https://worker.example.com/summaries", { method: "POST" })).status, 401);
  });

  test("an AI route calls Anthropic with the key from a Worker secret", async () => {
    const res = await mf.dispatchFetch("https://worker.example.com/summaries", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Inferlo runs on Cloudflare Workers." }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { summary: "One sentence." });
    assert.deepEqual(anthropicCalls.at(-1), { url: "https://api.anthropic.com/v1/messages", key: "sk-ant-test" });
  });

  test("a streamed AI answer", async () => {
    const res = await mf.dispatchFetch("https://worker.example.com/chat?q=Hi", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal([...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!) as string).join(""), "Streamed answer.");
  });

  test("the MCP server lists the AI route as a tool", async () => {
    const res = await mf.dispatchFetch("https://worker.example.com/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 200);
    const tools = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools, ["summarize"]);
  });
});
