/**
 * Throughput and latency benchmark: Inferlo against Fastify, Hono, Express and NestJS on Node.js.
 *
 *   node bench/perf/run.ts                          # every framework, both routes, 10 s each
 *   node bench/perf/run.ts --duration 5 --connections 100 --only inferlo,fastify
 *   node bench/perf/run.ts --json                   # machine-readable results
 *
 * Every framework serves the same two routes from its own process (bench/perf/servers/<name>.ts):
 *   GET  /hello  -> {"hello":"world"}
 *   POST /echo   {"name":"Ada","count":3} -> the validated body (invalid bodies get 422)
 * The load comes from autocannon in this process, after a warm-up, one framework at a time. Results depend on
 * the machine, so compare frameworks within one run, not across machines.
 */
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";

export const FRAMEWORKS = ["inferlo", "fastify", "hono", "express", "nestjs"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export interface Scenario {
  name: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  expect: string;
}

export const SCENARIOS: Scenario[] = [
  { name: "GET /hello (JSON)", method: "GET", path: "/hello", expect: '{"hello":"world"}' },
  { name: "POST /echo (validated JSON body)", method: "POST", path: "/echo", body: '{"name":"Ada","count":3}', expect: '{"name":"Ada","count":3}' },
];

export interface Result {
  framework: Framework;
  scenario: string;
  /** Average requests per second. */
  requestsPerSecond: number;
  /** Latency percentiles in milliseconds. */
  p50: number;
  p99: number;
  errors: number;
  non2xx: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Starts bench/perf/servers/<framework>.ts in its own Node.js process and waits until it listens. */
export async function startServer(framework: Framework): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = fork(path.join(here, "servers", `${framework}.ts`), [], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
    execArgv: ["--no-warnings"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${framework} did not start within 20 s`)), 20_000);
    child.once("message", () => (clearTimeout(timer), resolve()));
    child.once("exit", (code) => (clearTimeout(timer), reject(new Error(`${framework} exited with code ${code}`))));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

/** One request, to check that a server answers the scenario correctly before it is measured. */
export async function check(url: string, s: Scenario): Promise<void> {
  const res = await fetch(url + s.path, { method: s.method, body: s.body, headers: s.body ? { "content-type": "application/json" } : {} });
  const text = await res.text();
  if (res.status !== 200 || text !== s.expect) throw new Error(`${url}${s.path} answered ${res.status} ${text}, expected 200 ${s.expect}`);
  if (s.body) {
    const bad = await fetch(url + s.path, { method: "POST", body: '{"name":"","count":-1}', headers: { "content-type": "application/json" } });
    await bad.arrayBuffer();
    if (bad.status < 400 || bad.status > 499) throw new Error(`${url}${s.path} accepted an invalid body (status ${bad.status})`);
  }
}

function load(url: string, s: Scenario, seconds: number, connections: number): Promise<autocannon.Result> {
  return autocannon({
    url: url + s.path,
    method: s.method,
    body: s.body,
    headers: s.body ? { "content-type": "application/json" } : {},
    connections,
    pipelining: 1,
    duration: seconds,
  });
}

/** Measures one framework on every scenario: a warm-up run, then the measured run. */
export async function measure(framework: Framework, options: { duration: number; connections: number; warmup: number }): Promise<Result[]> {
  const server = await startServer(framework);
  try {
    const results: Result[] = [];
    for (const s of SCENARIOS) {
      await check(server.url, s);
      if (options.warmup > 0) await load(server.url, s, options.warmup, options.connections);
      const r = await load(server.url, s, options.duration, options.connections);
      results.push({
        framework,
        scenario: s.name,
        requestsPerSecond: Math.round(r.requests.average),
        p50: r.latency.p50,
        p99: r.latency.p99,
        errors: r.errors + r.timeouts,
        non2xx: r.non2xx,
      });
    }
    return results;
  } finally {
    await server.stop();
  }
}

export function machine(): string {
  const cpu = os.cpus()[0]?.model.trim() ?? "unknown CPU";
  return `${cpu}, ${os.cpus().length} CPUs, Node.js ${process.version}, ${os.platform()} ${os.arch()}`;
}

/** A Markdown table: one row per framework, requests per second and p99 latency per scenario, relative to Inferlo. */
export function table(results: Result[]): string {
  const frameworks = [...new Set(results.map((r) => r.framework))];
  const lines = [
    `| Framework | ${SCENARIOS.map((s) => `${s.name} req/s | p99 ms`).join(" | ")} |`,
    `|---|${SCENARIOS.map(() => "---:|---:").join("|")}|`,
  ];
  for (const f of frameworks) {
    const cells = SCENARIOS.map((s) => {
      const r = results.find((x) => x.framework === f && x.scenario === s.name);
      return r ? `${r.requestsPerSecond.toLocaleString("en-US")} | ${r.p99}` : "- | -";
    });
    lines.push(`| ${f} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1]!;
  };
  const duration = Number(option("duration", "10"));
  const warmup = Number(option("warmup", "3"));
  const connections = Number(option("connections", "50"));
  const only = option("only", FRAMEWORKS.join(",")).split(",") as Framework[];
  for (const f of only) if (!FRAMEWORKS.includes(f)) throw new Error(`Unknown framework "${f}". Use ${FRAMEWORKS.join(", ")}.`);
  const json = argv.includes("--json");

  const results: Result[] = [];
  for (const f of only) {
    if (!json) process.stderr.write(`${f}...\n`);
    results.push(...(await measure(f, { duration, connections, warmup })));
  }
  const failed = results.filter((r) => r.errors || r.non2xx);
  if (json) console.log(JSON.stringify({ machine: machine(), duration, connections, results }, null, 2));
  else console.log(`${machine()}; ${connections} connections, ${duration} s per route after ${warmup} s warm-up\n\n${table(results)}`);
  if (failed.length) {
    console.error(`Errors or non-2xx answers: ${failed.map((r) => `${r.framework} ${r.scenario}`).join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
