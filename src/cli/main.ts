#!/usr/bin/env node
/**
 * kairo CLI. Every command supports --json for machine-readable output, so AI coding agents
 * can drive it directly.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { KairoError } from "../errors.ts";
import { KAIRO_VERSION } from "../describe.ts";

const HELP = `kairo ${KAIRO_VERSION}

Usage: kairo <command> [options]

Commands:
  new <dir>                Create a new Kairo project
  dev                      Run the server and restart on changes (src/server.ts)
  describe                 Print the app map: routes, models, auth, AI
  check                    Typecheck, load the app and run tests
  db push [--dry-run]      Create missing tables, columns and indexes
  openapi [--out file]     Print or write the OpenAPI document
  add resource <name>      Generate a model plus list/get/create/update/delete routes
  version                  Print the Kairo version

Options:
  --json                   Machine-readable output (for AI agents and scripts)
  --entry <file>           App module (default: package.json "kairo.entry" or src/app.ts)
`;

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--") && ["entry", "out"].includes(k)) out.flags[k] = argv[++i]!;
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const cwd = process.cwd();

async function readPackage(dir = cwd): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

async function entryFile(args: Args): Promise<string> {
  const pkg = await readPackage();
  const file = (args.flags.entry as string) || pkg?.kairo?.entry || "src/app.ts";
  return path.resolve(cwd, file);
}

async function loadApp(args: Args): Promise<any> {
  const file = await entryFile(args);
  if (!existsSync(file)) {
    throw new KairoError("KR8001", `App entry ${path.relative(cwd, file)} not found.`, {
      fix: 'Create src/app.ts exporting `app`, pass --entry <file>, or set "kairo": { "entry": "..." } in package.json.',
    });
  }
  const mod = await import(pathToFileURL(file).href);
  const app = mod.app ?? mod.default;
  if (!app || typeof app.describe !== "function") {
    throw new KairoError("KR8002", `${path.relative(cwd, file)} does not export a Kairo app.`, { fix: "Add: export const app = createApp({ ... })" });
  }
  return app;
}

function print(data: unknown, json: boolean, text?: () => string) {
  if (json || !text) console.log(JSON.stringify(data, null, 2));
  else console.log(text());
}

function run(cmd: string, argv: string[], options: { capture?: boolean } = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit", shell: process.platform === "win32" });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    child.on("error", (e) => resolve({ code: 127, output: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

// ---------------------------------------------------------------------------------------------

async function cmdDescribe(args: Args) {
  const app = await loadApp(args);
  const d = app.describe();
  print(d, Boolean(args.flags.json), () => {
    const lines = [`${d.name} ${d.version}  (kairo ${d.kairo}, db: ${d.database}, auth: ${d.auth ? "on" : "off"})`, "", "Models"];
    for (const m of d.models) {
      lines.push(`  ${m.name}`);
      for (const [k, f] of Object.entries<any>(m.fields)) {
        const extra = [f.required ? "required" : "", f.unique ? "unique" : "", f.references ? `-> ${f.references}` : "", f.values ? f.values.join("|") : ""].filter(Boolean).join(", ");
        lines.push(`    ${k.padEnd(16)} ${f.type}${extra ? `  (${extra})` : ""}`);
      }
    }
    lines.push("", "Routes");
    for (const r of d.routes) lines.push(`  ${r.method.padEnd(6)} ${r.path.padEnd(28)} auth=${r.auth}${r.tool ? `  tool=${r.tool}` : ""}${r.name ? `  (${r.name})` : ""}`);
    lines.push("", `AI: ${d.ai.configured ? Object.entries<string[]>(d.ai.aliases).map(([a, ids]) => `${a} = ${ids.join(" > ")}`).join("; ") || "configured" : "not configured"}`);
    if (d.endpoints.openapi) lines.push(`OpenAPI: ${d.endpoints.openapi}`);
    if (d.endpoints.mcp) lines.push(`MCP: ${d.endpoints.mcp}`);
    return lines.join("\n");
  });
}

async function cmdOpenapi(args: Args) {
  const app = await loadApp(args);
  const doc = JSON.stringify(app.openapi(), null, 2);
  if (typeof args.flags.out === "string") {
    await writeFile(path.resolve(cwd, args.flags.out), doc + "\n");
    print({ ok: true, file: args.flags.out }, Boolean(args.flags.json), () => `Wrote ${args.flags.out}`);
  } else console.log(doc);
}

async function cmdDb(args: Args) {
  if (args._[1] !== "push") throw new KairoError("KR8003", `Unknown db command "${args._[1] ?? ""}".`, { fix: "Use: kairo db push [--dry-run]" });
  const app = await loadApp(args);
  const dryRun = Boolean(args.flags["dry-run"]);
  const statements: string[] = await app.db.$sync({ dryRun });
  await app.db.$close();
  print({ ok: true, dryRun, statements }, Boolean(args.flags.json), () =>
    statements.length ? `${dryRun ? "Would run" : "Ran"}:\n\n${statements.join(";\n\n")};` : "Database is up to date.",
  );
}

interface Step {
  name: string;
  ok: boolean;
  skipped?: boolean;
  durationMs: number;
  errors: { file?: string; line?: number; code?: string; message: string; fix?: string }[];
  output?: string;
}

async function cmdCheck(args: Args) {
  const json = Boolean(args.flags.json);
  const steps: Step[] = [];
  const timed = async (name: string, fn: (step: Step) => Promise<void>) => {
    const step: Step = { name, ok: true, durationMs: 0, errors: [] };
    const start = Date.now();
    try {
      await fn(step);
    } catch (error) {
      step.ok = false;
      const e = error as KairoError;
      step.errors.push({ code: e.code, message: e.message ?? String(error), fix: e.fix });
    }
    step.durationMs = Date.now() - start;
    steps.push(step);
    if (!json) console.log(`${step.skipped ? "skip" : step.ok ? "ok  " : "FAIL"}  ${name} (${step.durationMs} ms)`);
  };

  await timed("typecheck", async (step) => {
    const tsc = path.join(cwd, "node_modules", ".bin", "tsc");
    if (!existsSync(path.join(cwd, "tsconfig.json")) || !existsSync(tsc)) {
      step.skipped = true;
      return;
    }
    const { code, output } = await run(tsc, ["--noEmit", "--pretty", "false"], { capture: true });
    if (code !== 0) {
      step.ok = false;
      for (const line of output.split("\n")) {
        const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line.trim());
        if (m) step.errors.push({ file: m[1], line: Number(m[2]), code: m[3], message: m[4]! });
      }
      if (!step.errors.length) step.errors.push({ message: output.trim().slice(0, 4000) });
    }
  });

  await timed("load", async () => {
    await loadApp(args);
  });

  await timed("test", async (step) => {
    const pkg = await readPackage();
    if (!pkg?.scripts?.test) {
      step.skipped = true;
      return;
    }
    const { code, output } = await run("npm", ["test", "--silent"], { capture: true });
    if (code !== 0) {
      step.ok = false;
      step.output = output.slice(-6000);
      step.errors.push({ message: "Tests failed. See output." });
    }
  });

  const ok = steps.every((s) => s.ok);
  if (json) console.log(JSON.stringify({ ok, steps }, null, 2));
  else {
    for (const s of steps.filter((s) => !s.ok)) {
      console.log(`\n${s.name}:`);
      for (const e of s.errors) console.log(`  ${e.file ? `${e.file}:${e.line}  ` : ""}${e.code ? e.code + "  " : ""}${e.message}${e.fix ? `\n  Fix: ${e.fix}` : ""}`);
      if (s.output) console.log(s.output);
    }
    console.log(ok ? "\nAll checks passed." : "\nChecks failed.");
  }
  process.exitCode = ok ? 0 : 1;
}

async function cmdDev(args: Args) {
  const pkg = await readPackage();
  const server = path.resolve(cwd, (args.flags.entry as string) || pkg?.kairo?.server || "src/server.ts");
  if (!existsSync(server)) throw new KairoError("KR8001", `Server file ${path.relative(cwd, server)} not found.`, { fix: "Create src/server.ts that calls app.listen()." });
  const isBun = Boolean((globalThis as { Bun?: unknown }).Bun);
  const cmd = isBun ? "bun" : process.execPath;
  const argv = isBun ? ["--watch", server] : ["--watch", "--env-file-if-exists=.env", server];
  const { code } = await run(cmd, argv);
  process.exitCode = code;
}

// --- generators --------------------------------------------------------------------------

const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

async function copyTemplate(from: string, to: string, vars: Record<string, string>, created: string[]) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const name = entry.name.replace(/^_/, ".").replace(/\.tpl$/, "");
    const dest = path.join(to, name);
    if (entry.isDirectory()) await copyTemplate(src, dest, vars, created);
    else {
      let text = await readFile(src, "utf8");
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
      await writeFile(dest, text);
      created.push(dest);
    }
  }
}

async function cmdNew(args: Args) {
  const dir = args._[1];
  if (!dir) throw new KairoError("KR8004", "Missing project directory.", { fix: "Use: kairo new my-app" });
  const target = path.resolve(cwd, dir);
  if (existsSync(target) && (await readdir(target)).length) throw new KairoError("KR8005", `${dir} already exists and is not empty.`);
  const name = path.basename(target).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const created: string[] = [];
  await copyTemplate(path.join(templatesDir, "app"), target, { name, kairoVersion: KAIRO_VERSION, kairoDependency: `^${KAIRO_VERSION}` }, created);
  print({ ok: true, dir, files: created.map((f) => path.relative(cwd, f)) }, Boolean(args.flags.json), () =>
    [`Created ${dir}`, "", "Next:", `  cd ${dir}`, "  npm install", "  npm run dev", "", "AGENTS.md explains the conventions to AI coding agents."].join("\n"),
  );
}

function pascal(name: string): string {
  return name.replace(/(^|[_-])([a-z])/g, (_, __, c: string) => c.toUpperCase());
}

function singularOf(name: string): string {
  return name.endsWith("ies") ? name.slice(0, -3) + "y" : name.endsWith("s") ? name.slice(0, -1) : name;
}

async function cmdAdd(args: Args) {
  const kind = args._[1];
  const raw = args._[2];
  if (kind !== "resource" || !raw) throw new KairoError("KR8006", "Use: kairo add resource <plural_name>, e.g. kairo add resource invoices");
  const table = raw.toLowerCase().replace(/-/g, "_");
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new KairoError("KR4005", `"${raw}" is not a valid table name.`, { fix: "Use lowercase letters, digits and underscores." });
  const Model = pascal(singularOf(table));
  const routesDir = path.join(cwd, "src", "routes");
  const routeFile = path.join(routesDir, `${table}.ts`);
  if (existsSync(routeFile)) throw new KairoError("KR8005", `src/routes/${table}.ts already exists.`);
  const changes: string[] = [];
  const manual: string[] = [];

  const modelsFile = path.join(cwd, "src", "models.ts");
  const modelCode = `export const ${Model} = model("${table}", {\n  name: t.string().max(200),\n  ownerId: t.ref("users"),\n});\n`;
  if (existsSync(modelsFile)) {
    let text = await readFile(modelsFile, "utf8");
    if (text.includes("// kairo:models")) {
      text = text.replace("// kairo:models", `${modelCode}\n// kairo:models`);
      text = text.replace(/export const models = \[([^\]]*)\]/, (m, list: string) => `export const models = [${list.trim() ? list.trim().replace(/,\s*$/, "") + ", " : ""}${Model}]`);
      await writeFile(modelsFile, text);
      changes.push("src/models.ts");
    } else manual.push(`Add to src/models.ts:\n${modelCode}\nand add ${Model} to the models array.`);
  } else manual.push(`Create the ${Model} model:\n${modelCode}`);

  const routeCode = `import { route, t, notFound } from "@kairojs/core";
import { ${Model} } from "../models.ts";

const IdParams = t.object({ id: t.uuid() });

export const list${pascal(table)} = route
  .get("/${table}", {
    summary: "List ${table}",
    query: t.object({ limit: t.int().min(1).max(100).default(20), offset: t.int().min(0).default(0) }),
    tool: true,
  })
  .handle(({ query, user, db }) =>
    db.${table}.findMany({ where: { ownerId: user.id }, orderBy: { createdAt: "desc" }, limit: query.limit, offset: query.offset }),
  );

export const get${Model} = route
  .get("/${table}/:id", { params: IdParams, summary: "Get one ${singularOf(table)}", tool: true })
  .handle(async ({ params, user, db }) => {
    const row = await db.${table}.get(params.id);
    if (row.ownerId !== user.id) throw notFound();
    return row;
  });

export const create${Model} = route
  .post("/${table}", { body: ${Model}.omit("ownerId"), summary: "Create a ${singularOf(table)}", tool: true })
  .handle(({ body, user, db, status }) => {
    status(201);
    return db.${table}.insert({ ...body, ownerId: user.id });
  });

export const update${Model} = route
  .patch("/${table}/:id", { params: IdParams, body: ${Model}.omit("ownerId").partial(), summary: "Update a ${singularOf(table)}" })
  .handle(async ({ params, body, user, db }) => {
    const row = await db.${table}.get(params.id);
    if (row.ownerId !== user.id) throw notFound();
    return db.${table}.update(row.id, body);
  });

export const delete${Model} = route
  .delete("/${table}/:id", { params: IdParams, summary: "Delete a ${singularOf(table)}" })
  .handle(async ({ params, user, db }) => {
    const row = await db.${table}.get(params.id);
    if (row.ownerId !== user.id) throw notFound();
    await db.${table}.delete(row.id);
  });
`;
  await mkdir(routesDir, { recursive: true });
  await writeFile(routeFile, routeCode);
  changes.push(`src/routes/${table}.ts`);

  const appFile = path.join(cwd, "src", "app.ts");
  if (existsSync(appFile)) {
    let text = await readFile(appFile, "utf8");
    if (text.includes("// kairo:routes")) {
      text = text.replace(/^(import .*\n)(?![\s\S]*^import )/m, `$1import * as ${table} from "./routes/${table}.ts";\n`);
      text = text.replace(/routes: \[([^\]]*)\]/, (_m, list: string) => `routes: [${list.trim() ? list.trim().replace(/,\s*$/, "") + ", " : ""}${table}]`);
      await writeFile(appFile, text);
      changes.push("src/app.ts");
    } else manual.push(`Add to src/app.ts:\nimport * as ${table} from "./routes/${table}.ts";\nand add ${table} to createApp({ routes: [...] }).`);
  }

  print({ ok: true, changed: changes, manual }, Boolean(args.flags.json), () =>
    [`Updated: ${changes.join(", ")}`, ...manual.map((m) => `\nTo do:\n${m}`), "", "Then run: kairo db push && kairo check"].join("\n"),
  );
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  try {
    switch (command) {
      case "new":
        return await cmdNew(args);
      case "dev":
        return await cmdDev(args);
      case "describe":
        return await cmdDescribe(args);
      case "check":
        return await cmdCheck(args);
      case "db":
        return await cmdDb(args);
      case "openapi":
        return await cmdOpenapi(args);
      case "add":
        return await cmdAdd(args);
      case "version":
      case "--version":
      case "-v":
        return console.log(KAIRO_VERSION);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return console.log(HELP);
      default:
        throw new KairoError("KR8000", `Unknown command "${command}".`, { fix: "Run kairo help to see all commands." });
    }
  } catch (error) {
    const json = Boolean(args.flags.json);
    if (error instanceof KairoError) {
      if (json) console.log(JSON.stringify({ ok: false, ...error.toJSON(), message: error.message }, null, 2));
      else console.error(error.format());
    } else {
      if (json) console.log(JSON.stringify({ ok: false, error: { code: "KR9000", message: String((error as Error)?.message ?? error) } }, null, 2));
      else console.error(error);
    }
    process.exitCode = 1;
  }
}

await main();
