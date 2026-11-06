/**
 * Performance regression check (run in CI): fails when Inferlo's throughput, relative to Fastify's on the same
 * machine in the same run, drops below the floor for a scenario in bench/perf/limits.json.
 *
 *   node bench/perf/check.ts                        # 3 rounds, 5 s per route after a 2 s warm-up
 *   node bench/perf/check.ts --rounds 5 --duration 10
 *
 * Absolute requests per second depend on the runner, so they are never compared. Each round measures Inferlo and
 * then Fastify on every scenario (bench/perf/run.ts), and the check uses the median of the per-round ratios
 * Inferlo / Fastify, so one noisy round does not decide the result. Raise a floor in limits.json when a change
 * makes Inferlo faster, so the gain is kept; never lower one to make a slower change pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { machine, measure, type Result } from "./run.ts";

export interface Limits {
  /** Lowest allowed Inferlo / Fastify throughput ratio per scenario name (0.2 = 20% of Fastify's requests per second). */
  minRatio: Record<string, number>;
}

export function median(values: number[]): number {
  if (!values.length) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The median Inferlo / Fastify ratio per scenario over rounds. Throws when a measured run had errors or non-2xx answers. */
export function ratios(rounds: Result[][]): Record<string, number> {
  const perScenario: Record<string, number[]> = {};
  for (const round of rounds) {
    for (const r of round) {
      if (r.errors || r.non2xx) throw new Error(`${r.framework} ${r.scenario}: ${r.errors} errors and ${r.non2xx} non-2xx answers under load`);
    }
    for (const inferlo of round.filter((r) => r.framework === "inferlo")) {
      const fastify = round.find((r) => r.framework === "fastify" && r.scenario === inferlo.scenario);
      if (!fastify || fastify.requestsPerSecond <= 0) continue;
      (perScenario[inferlo.scenario] ??= []).push(inferlo.requestsPerSecond / fastify.requestsPerSecond);
    }
  }
  return Object.fromEntries(Object.entries(perScenario).map(([scenario, values]) => [scenario, Math.round(median(values) * 1000) / 1000]));
}

const percent = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;

/** Compares measured ratios with the floors: a Markdown report, and one message per scenario that fails. */
export function evaluate(measured: Record<string, number>, limits: Limits): { failures: string[]; report: string } {
  const failures: string[] = [];
  const lines = ["| Scenario | Inferlo / Fastify | Floor | Result |", "|---|---:|---:|---|"];
  for (const scenario of new Set([...Object.keys(limits.minRatio), ...Object.keys(measured)])) {
    const ratio = measured[scenario];
    const floor = limits.minRatio[scenario];
    if (floor === undefined) {
      failures.push(`${scenario}: no floor in bench/perf/limits.json; add one`);
      continue;
    }
    if (ratio === undefined) {
      failures.push(`${scenario}: no measurement for a scenario with a floor`);
      continue;
    }
    const ok = ratio >= floor;
    lines.push(`| ${scenario} | ${percent(ratio)} | ${percent(floor)} | ${ok ? "ok" : "below"} |`);
    if (!ok) failures.push(`${scenario}: Inferlo reached ${percent(ratio)} of Fastify's throughput, below the floor of ${percent(floor)}`);
  }
  return { failures, report: lines.join("\n") };
}

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return Number(i === -1 ? fallback : argv[i + 1]);
  };
  const rounds = option("rounds", "3");
  const options = { duration: option("duration", "5"), warmup: option("warmup", "2"), connections: option("connections", "50") };
  const limits = JSON.parse(readFileSync(path.join(here, "limits.json"), "utf8")) as Limits;

  const results: Result[][] = [];
  for (let i = 1; i <= rounds; i++) {
    process.stderr.write(`round ${i} of ${rounds}...\n`);
    results.push([...(await measure("inferlo", options)), ...(await measure("fastify", options))]);
  }
  const { failures, report } = evaluate(ratios(results), limits);
  console.log(`${machine()}; ${rounds} rounds, ${options.connections} connections, ${options.duration} s per route after ${options.warmup} s warm-up\n\n${report}`);
  for (const [i, round] of results.entries()) {
    console.log(`\nRound ${i + 1}: ${round.map((r) => `${r.framework} ${r.scenario} ${r.requestsPerSecond} req/s`).join(", ")}`);
  }
  if (failures.length) {
    console.error(`\nPerformance regression:\n- ${failures.join("\n- ")}\nProfile the change (node --cpu-prof bench/perf/servers/inferlo.ts) or explain in the commit why the cost is needed.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
