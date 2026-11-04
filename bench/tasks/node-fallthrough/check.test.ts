import assert from "node:assert/strict";
import { test } from "node:test";
import { createLegacyServer } from "../src/legacy.ts";

test("Inferlo answers its routes at the same URLs and the old service answers the rest", async () => {
  const original = console.log;
  console.log = () => {};
  const server = createLegacyServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const create = await fetch(`${base}/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(create.status, 401, "POST /notes is answered by Inferlo (sign-in required)");
    assert.equal((await create.json()).error.code, "IL3001");
    const one = await fetch(`${base}/notes/00000000-0000-4000-8000-000000000001`);
    assert.equal(one.status, 401, "GET /notes/:id is answered by Inferlo");
    for (const [method, path] of [["GET", "/reports"], ["PUT", "/notes"], ["GET", "/"], ["DELETE", "/health"]] as const) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 200, `${method} ${path} goes to the old service`);
      assert.equal(await res.text(), "legacy", `${method} ${path} goes to the old service`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    console.log = original;
  }
});
