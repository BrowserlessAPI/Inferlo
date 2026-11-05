import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type Koa from "koa";
import { createKoaServer } from "../src/koa.ts";

test("the Inferlo app is mounted under /api in Koa, and ctx.ai is set", async () => {
  const source = readFileSync(new URL("../src/koa.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/koa/, "uses the Koa entry point");
  const koa = createKoaServer();
  let sawAI = false;
  koa.middleware.splice(koa.middleware.length - 1, 0, (async (ctx: Koa.Context, next: Koa.Next) => {
    sawAI = typeof ctx.ai?.generate === "function";
    await next();
  }) as never);
  const server = koa.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const doc = await fetch(`${base}/api/openapi.json`);
    assert.ok((await doc.json()).paths["/notes"]);
    assert.equal((await fetch(`${base}/api/notes`)).status, 401, "app auth still applies");
    const other = await fetch(`${base}/status`);
    assert.equal(other.status, 200);
    assert.equal(await other.text(), "koa");
    assert.equal(await (await fetch(`${base}/apix`)).text(), "koa");
    assert.ok(sawAI, "ctx.ai is set for Koa middleware");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
