import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { evaluate, median, ratios, type Limits } from "../bench/perf/check.ts";
import { SCENARIOS, type Result } from "../bench/perf/run.ts";

// The performance regression check (bench/perf/check.ts, run in CI) compares Inferlo's throughput to Fastify's
// measured on the same runner in the same run, so the speed of the runner cancels out.

const [get, post] = SCENARIOS.map((s) => s.name) as [string, string];
const r = (framework: "inferlo" | "fastify", scenario: string, requestsPerSecond: number, errors = 0): Result => ({ framework, scenario, requestsPerSecond, p50: 1, p99: 2, errors, non2xx: 0 });
const limits: Limits = { minRatio: { [get]: 0.2, [post]: 0.2 } };

describe("performance regression check", () => {
  test("median of an odd and an even number of values", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.throws(() => median([]));
  });

  test("ratios pair each round's Inferlo result with Fastify's and take the median per scenario", () => {
    const rounds = [
      [r("inferlo", get, 300), r("fastify", get, 1000), r("inferlo", post, 250), r("fastify", post, 1000)],
      [r("inferlo", get, 200), r("fastify", get, 1000), r("inferlo", post, 300), r("fastify", post, 1000)],
      [r("inferlo", get, 900), r("fastify", get, 1000), r("inferlo", post, 260), r("fastify", post, 1000)],
    ];
    assert.deepEqual(ratios(rounds), { [get]: 0.3, [post]: 0.26 });
  });

  test("passes at or above the floor and fails below it, naming the scenario", () => {
    assert.deepEqual(evaluate({ [get]: 0.25, [post]: 0.2 }, limits).failures, []);
    const { failures, report } = evaluate({ [get]: 0.15, [post]: 0.3 }, limits);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!, new RegExp(`${get.replace(/[()/]/g, "\\$&")}: Inferlo reached 15\\.0% of Fastify's throughput, below the floor of 20\\.0%`));
    assert.match(report, /\| GET \/hello \(JSON\) \| 15\.0% \| 20\.0% \| below \|/);
  });

  test("a scenario without a floor, or a floor without a measurement, fails", () => {
    assert.match(evaluate({ [get]: 0.3 }, limits).failures.join("\n"), /POST \/echo .*no measurement/);
    assert.match(evaluate({ [get]: 0.3, [post]: 0.3, "GET /other": 0.3 }, limits).failures.join("\n"), /GET \/other.*no floor in bench\/perf\/limits\.json/);
  });

  test("a round with errors or non-2xx answers fails the check instead of being measured", () => {
    assert.throws(() => ratios([[r("inferlo", get, 300, 2), r("fastify", get, 1000)]]), /inferlo GET \/hello \(JSON\): 2 errors/);
  });

  test("bench/perf/limits.json has a floor between 0 and 1 for every scenario", () => {
    const file = JSON.parse(readFileSync(new URL("../bench/perf/limits.json", import.meta.url), "utf8")) as Limits;
    assert.deepEqual(Object.keys(file.minRatio).sort(), SCENARIOS.map((s) => s.name).sort());
    for (const value of Object.values(file.minRatio)) assert.ok(value > 0 && value < 1);
  });
});
