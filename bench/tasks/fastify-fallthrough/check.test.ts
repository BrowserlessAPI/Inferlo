import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Inferlo answers its routes at their own URLs inside Fastify, and Fastify keeps the rest", async () => {
  const source = readFileSync(new URL("../src/fastify.ts", import.meta.url), "utf8");
  assert.match(source, /@browserlessapi\/inferlo\/fastify/, "uses the Fastify entry point");
  const { buildServer } = await import("../src/fastify.ts");
  const fastify = await buildServer();
  try {
    const legacy = await fastify.inject("/legacy");
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.body, "fastify");
    const put = await fastify.inject({ method: "PUT", url: "/notes/n1", payload: { title: "Hi" } });
    assert.deepEqual(put.json(), { from: "fastify", id: "n1" }, "PUT /notes/:id stays with Fastify");
    const list = await fastify.inject("/notes");
    assert.equal(list.statusCode, 401, "GET /notes is the Inferlo route, private by default");
    assert.equal(list.json().error.code, "IL3001");
    const patch = await fastify.inject({ method: "PATCH", url: "/notes/n1", payload: { title: "Hi" } });
    assert.equal(patch.json().error.code, "IL3001", "PATCH on the same path is Inferlo's");
    assert.deepEqual((await fastify.inject("/health")).json(), { status: "ok" });
    assert.ok((await fastify.inject("/openapi.json")).json().paths["/notes"]);
    const missing = await fastify.inject("/nothing-here");
    assert.equal(missing.statusCode, 404);
    assert.match(missing.json().message, /Route GET:\/nothing-here not found/, "Fastify's own 404");
  } finally {
    await fastify.close();
  }
});
