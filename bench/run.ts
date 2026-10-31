/**
 * Kairo AI success benchmark.
 *
 * Each task in bench/tasks/<id>/ starts from the `kairo new` project (plus optional setup/ files),
 * gives an AI model the task prompt, the project's AGENTS.md and its source files, applies the
 * files the model returns, then runs the typecheck and the task's check.test.ts. A task passes
 * only if both succeed on the first try.
 *
 *   node bench/run.ts --verify                                  # apply reference solutions (CI)
 *   node bench/run.ts --baseline                                # no changes: every task must fail (CI)
 *   KAIRO_BENCH_MODEL=anthropic:claude-sonnet-4-5 ANTHROPIC_API_KEY=... node bench/run.ts
 *   KAIRO_BENCH_MODEL=local:qwen3-coder KAIRO_BENCH_BASE_URL=http://127.0.0.1:11434/v1 node bench/run.ts
 *
 * Options: --task <id>, --keep (keep work directories), --json
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic, createAI, openai, openaiCompatible, t, type Provider } from "../src/index.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tasksDir = path.join(repo, "bench", "tasks");
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function copyTemplate(from: string, to: string) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name.replace(/^_/, ".").replace(/\.tpl$/, ""));
    if (entry.isDirectory()) await copyTemplate(src, dest);
    else {
      const text = (await readFile(src, "utf8")).replaceAll("{{name}}", "bench-app").replaceAll("{{kairoDependency}}", "file:../kairo").replaceAll("{{kairoVersion}}", "0.1.0");
      await writeFile(dest, text);
    }
  }
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

async function prepare(taskId: string): Promise<string> {
  const work = await mkdtemp(path.join(os.tmpdir(), `kairo-bench-${taskId}-`));
  await copyTemplate(path.join(repo, "templates", "app"), work);
  const setup = path.join(tasksDir, taskId, "setup");
  if (existsSync(setup)) await cp(setup, work, { recursive: true });
  await mkdir(path.join(work, "node_modules", "@types"), { recursive: true });
  await mkdir(path.join(work, "node_modules", "@browserlessapi"), { recursive: true });
  await symlink(repo, path.join(work, "node_modules", "@browserlessapi", "kairo"), "dir");
  await symlink(path.join(repo, "node_modules", "@types", "node"), path.join(work, "node_modules", "@types", "node"), "dir");
  return work;
}

async function verify(work: string, taskId: string): Promise<{ typecheck: boolean; tests: boolean; output: string }> {
  await cp(path.join(tasksDir, taskId, "check.test.ts"), path.join(work, "test", "check.test.ts"));
  const tsc = await run(process.execPath, [path.join(repo, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", work], work);
  const tests = await run(process.execPath, ["--test", "test/check.test.ts"], work);
  return { typecheck: tsc.code === 0, tests: tests.code === 0, output: (tsc.code ? tsc.output : "") + (tests.code ? tests.output : "") };
}

function providerFor(id: string): Record<string, Provider> {
  const name = id.split(":")[0]!;
  const env = process.env;
  if (env.KAIRO_BENCH_BASE_URL) return { [name]: openaiCompatible({ name, baseURL: env.KAIRO_BENCH_BASE_URL, apiKey: env.KAIRO_BENCH_API_KEY }) };
  if (name === "anthropic") return { anthropic: anthropic({ apiKey: env.ANTHROPIC_API_KEY ?? "" }) };
  if (name === "openai") return { openai: openai({ apiKey: env.OPENAI_API_KEY ?? "" }) };
  throw new Error(`No provider for "${name}". Set KAIRO_BENCH_BASE_URL for OpenAI-compatible servers.`);
}

const Answer = t.object({
  files: t.array(t.object({ path: t.string().describe("Path relative to the project root, e.g. src/routes/notes.ts"), content: t.text().describe("Full new file content") })),
});

async function solveWithModel(work: string, taskId: string, prompt: string, modelId: string) {
  const ai = createAI({ providers: providerFor(modelId) });
  const files = [];
  for (const dir of ["src", "migrations"]) if (existsSync(path.join(work, dir))) files.push(...(await listFiles(path.join(work, dir))).map((f) => path.join(dir, f)));
  const sources = await Promise.all(files.map(async (f) => `--- ${f}\n${await readFile(path.join(work, f), "utf8")}`));
  const agents = await readFile(path.join(work, "AGENTS.md"), "utf8");
  const { object, usage } = await ai.generate({
    model: modelId,
    system: `You are working on a backend built with the Kairo framework. Follow these project rules:\n\n${agents}`,
    prompt: `Task: ${prompt}\n\nProject files:\n\n${sources.join("\n\n")}\n\nReturn every file you create or change, with its full content.`,
    output: Answer,
    maxTokens: 16000,
    temperature: 0,
  });
  for (const file of object.files) {
    const target = path.resolve(work, file.path);
    if (!target.startsWith(work + path.sep) || file.path.includes("node_modules")) throw new Error(`Refusing to write outside the project: ${file.path}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  void taskId;
  return usage;
}

async function main() {
  const baseline = flag("baseline");
  const verifyMode = flag("verify") || baseline;
  const modelId = process.env.KAIRO_BENCH_MODEL;
  if (!verifyMode && !modelId) {
    console.log("Set KAIRO_BENCH_MODEL (e.g. anthropic:claude-sonnet-4-5) and the provider API key, or run with --verify.");
    return;
  }
  if (!existsSync(path.join(repo, "dist", "index.js"))) {
    console.error("Run npm run build first (the benchmark uses the built package).");
    process.exitCode = 1;
    return;
  }
  const only = option("task");
  const ids = (await readdir(tasksDir)).filter((id) => !only || id === only).sort();
  const results: { id: string; title: string; passed: boolean; typecheck: boolean; tests: boolean; seconds: number; inputTokens?: number; outputTokens?: number; error?: string }[] = [];

  for (const id of ids) {
    const task = JSON.parse(await readFile(path.join(tasksDir, id, "task.json"), "utf8")) as { title: string; prompt: string };
    const started = Date.now();
    const work = await prepare(id);
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let error: string | undefined;
    try {
      if (baseline) {
        /* untouched project */
      } else if (verifyMode) await cp(path.join(tasksDir, id, "solution"), work, { recursive: true });
      else usage = await solveWithModel(work, id, task.prompt, modelId!);
    } catch (e) {
      error = String((e as Error).message ?? e);
    }
    const check = error ? { typecheck: false, tests: false, output: error } : await verify(work, id);
    const passed = check.typecheck && check.tests;
    results.push({ id, title: task.title, passed, typecheck: check.typecheck, tests: check.tests, seconds: Math.round((Date.now() - started) / 100) / 10, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, error: passed ? undefined : (error ?? check.output.slice(-2000)) });
    if (!flag("json")) console.log(`${passed ? "pass" : "FAIL"}  ${id}  (${task.title})`);
    if (!passed && !flag("json") && !baseline) console.log(check.output.slice(-1500));
    if (!flag("keep")) await rm(work, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.passed).length;
  const summary = { mode: verifyMode ? "verify" : "model", model: verifyMode ? "reference-solutions" : modelId, date: new Date().toISOString(), passed, total: results.length, rate: results.length ? passed / results.length : 0, results };
  if (!verifyMode) {
    const dir = path.join(repo, "bench", "results");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${summary.date.slice(0, 10)}-${modelId!.replace(/[^a-z0-9.-]+/gi, "_")}.json`), JSON.stringify(summary, null, 2) + "\n");
  }
  if (flag("json")) console.log(JSON.stringify(summary, null, 2));
  else console.log(`\n${passed}/${results.length} tasks passed${baseline ? " with no changes (expected 0)" : verifyMode ? " with reference solutions" : ` on the first try with ${modelId}`}.`);
  if (baseline) {
    if (passed) {
      console.error(`${passed} task(s) pass without any change, so their checks test nothing. Fix the check.test.ts files.`);
      process.exitCode = 1;
    }
  } else if (verifyMode && passed !== results.length) process.exitCode = 1;
}

await main();
