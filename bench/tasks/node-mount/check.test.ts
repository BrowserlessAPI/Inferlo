import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createLegacyServer } from "../src/legacy.ts";

test("the Inferlo app is mounted under /api inside the node:http server", async () => {
  const source = readFileSync(new URL("../src/legacy.ts", import.meta.url), "utf8");
  assert.match(source, /toNodeHandler/, "uses toNodeHandler to mount the app");
  const server = createLegacyServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const doc = await fetch(`${base}/api/openapi.json`);
    assert.equal(doc.status, 200);
    assert.ok((await doc.json()).paths["/notes"]);
    const notes = await fetch(`${base}/api/notes`);
    assert.equal(notes.status, 401, "app auth still applies");
    const old = await fetch(`${base}/status`);
    assert.equal(old.status, 200);
    assert.equal(await old.text(), "legacy");
    const lookalike = await fetch(`${base}/apix`);
    assert.equal(await lookalike.text(), "legacy");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
