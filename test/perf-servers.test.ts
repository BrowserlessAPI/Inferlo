import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { check, FRAMEWORKS, SCENARIOS, startServer, table } from "../bench/perf/run.ts";

// The performance benchmark (bench/perf) only measures servers that answer every scenario correctly, so each
// framework's server is started here and checked, without load. The benchmark forks Node.js processes.
const isBun = "Bun" in globalThis;

(isBun ? describe.skip : describe)("performance benchmark servers", () => {
  for (const framework of FRAMEWORKS) {
    test(`${framework} answers every scenario and rejects an invalid body`, async () => {
      const server = await startServer(framework);
      try {
        for (const s of SCENARIOS) await check(server.url, s);
      } finally {
        await server.stop();
      }
    });
  }

  test("results print as a Markdown table, one row per framework", () => {
    const rows = table([
      { framework: "inferlo", scenario: SCENARIOS[0]!.name, requestsPerSecond: 12345, p50: 3, p99: 9, errors: 0, non2xx: 0 },
      { framework: "fastify", scenario: SCENARIOS[1]!.name, requestsPerSecond: 999, p50: 1, p99: 2, errors: 0, non2xx: 0 },
    ]).split("\n");
    assert.equal(rows.length, 4);
    assert.equal(rows[2], "| inferlo | 12,345 | 9 | - | - |");
    assert.equal(rows[3], "| fastify | - | - | 999 | 2 |");
  });
});
