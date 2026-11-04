import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { IgnitorFactory } from "@adonisjs/core/factories";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { createApp, InferloError } from "../src/index.ts";

const APP_ROOT = new URL("./tmp-adonisjs/", import.meta.url);

function makeAI(reply = '{"label":"bug"}') {
  const usage: { for?: string }[] = [];
  const ai = createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
  return { ai, usage };
}

/** Boots an AdonisJS web app with the Inferlo provider and the given config/ai.ts value. */
async function boot(aiConfig: unknown) {
  const ignitor = new IgnitorFactory()
    .withCoreConfig()
    .merge({
      // The app provider (HTTP server, router) and Inferlo's. Not withCoreProviders(): its REPL provider
      // needs node:repl features that Bun 1.3.0 does not have.
      rcFileContents: { providers: [() => import("@adonisjs/core/providers/app_provider"), () => import("../src/adonisjs.ts")] },
      config: aiConfig === undefined ? {} : { ai: aiConfig },
    })
    .create(APP_ROOT, { importer: (path) => import(path) });
  const app = ignitor.createApp("web");
  await app.init();
  await app.boot();
  return app;
}

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

describe("AdonisJS provider", () => {
  test("binds the AI client from config/ai.ts in the container and adds ctx.ai to HTTP contexts", async () => {
    const { ai, usage } = makeAI();
    const app = await boot(ai);
    assert.equal(await app.container.make("ai"), ai);

    const router = await app.container.make("router");
    router.post("/classify", async ({ ai, request }) => {
      const { object } = await ai.generate({ model: "fast", prompt: String(request.input("text")), output: t.object({ label: t.enum(["bug", "feature"]) }), for: "user-1" });
      return object;
    });
    router.get("/chat", async ({ ai, response }) => {
      const stream = ai.stream({ model: "fast", prompt: "hi" });
      response.header("content-type", "text/plain; charset=utf-8");
      return stream.text();
    });
    const server = await app.container.make("server");
    await server.boot();
    const http = createServer(server.handle.bind(server));
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/classify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "It crashes" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { label: "bug" });
    assert.equal(usage[0]?.for, "user-1");
    assert.equal(await (await fetch(`${base}/chat`)).text(), '{"label":"bug"}');
    await app.terminate();
  });

  test("works with an Inferlo app's app.ai", async () => {
    const inferlo = createApp({ ai: { providers: { mock: mockProvider({ respond: () => "pong" }) }, models: { fast: "mock:m" } }, logger: { info() {}, error() {} } });
    const app = await boot(inferlo.ai);
    const ai = await app.container.make("ai");
    assert.equal((await ai.generate({ model: "fast", prompt: "ping" })).text, "pong");
    await app.terminate();
  });

  test("a missing config/ai.ts raises IL5018 and anything that is not an AI client raises IL5014 when the app boots", async () => {
    await assert.rejects(boot(undefined), (e: unknown) => e instanceof InferloError && e.code === "IL5018" && /config\/ai\.ts/.test(e.fix ?? ""));
    for (const value of [{}, { generate() {} }, "anthropic"]) {
      await assert.rejects(boot(value), (e: unknown) => e instanceof InferloError && e.code === "IL5014", JSON.stringify(value));
    }
  });
});
