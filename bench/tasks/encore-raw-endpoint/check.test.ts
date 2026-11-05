import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inferloHandler } from "../src/encore.ts";

test("the Inferlo app answers under /inferlo with the full path in the request URL", async () => {
  const source = readFileSync(new URL("../src/encore.ts", import.meta.url), "utf8");
  assert.match(source, /toNodeHandler/, "uses toNodeHandler");
  assert.doesNotMatch(source, /encore\.dev/, "does not import encore.dev");
  // Like an Encore raw endpoint: the handler gets (req, res) and nothing else, with the full path.
  const server = http.createServer((req, res) => void (inferloHandler as (req: http.IncomingMessage, res: http.ServerResponse) => unknown)(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/inferlo/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const doc = await fetch(`${base}/inferlo/openapi.json`);
    assert.equal(doc.status, 200);
    assert.ok((await doc.json()).paths["/notes"]);
    assert.equal((await fetch(`${base}/inferlo/notes`)).status, 401, "app auth still applies");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
