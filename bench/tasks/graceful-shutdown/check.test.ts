import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { app } from "../src/app.ts";
import { shutdown } from "../src/shutdown.ts";

test("shutdown() makes /ready answer 503, serves requests for a second, then refuses new ones", async () => {
  assert.equal((await app.request("/ready")).status, 200);
  const started = Date.now();
  const done = shutdown();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await app.request("/ready")).status, 503, "/ready answers 503 at once");
  assert.equal((await app.request("/health")).status, 200, "liveness stays 200");
  assert.notEqual((await app.request("/notes")).status, 503, "requests are still served during the delay");
  await done;
  assert.ok(Date.now() - started >= 900, "requests are served for about one second");
  const refused = await app.request("/notes");
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).error.code, "IL2006");
});

test("src/server.ts calls shutdown() on SIGTERM", async () => {
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  assert.match(server, /SIGTERM/);
  assert.match(server, /shutdown\(/);
});
