// Prisma Migrate and Inferlo's migrations on one database, in development: `prisma migrate dev` with Inferlo's
// tables listed in tables.external (prisma.config.ts) leaves them alone, and Inferlo leaves Prisma's tables alone.
// Runs the Prisma CLI (its schema engine) on a database and a shadow database of its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import { applyMigrations, planMigration } from "../../../src/index.ts";
import { ensurePrismaClient, prismaConfigPath } from "../generate.ts";

ensurePrismaClient();
const { makeApp, Reminder } = await import("../src/app.ts");

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, "..");
const root = join(exampleDir, "..", "..");
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const names = { main: `inferlo_prisma_${suffix}`, shadow: `inferlo_prisma_shadow_${suffix}` };
const urlFor = (name: string) => {
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  return url.toString();
};
let ctx: ReturnType<typeof makeApp>;
let config = "";

/** Runs the Prisma CLI in the example's directory on the test databases. */
function prisma(args: string[], configPath = config) {
  const pkg = JSON.parse(readFileSync(join(root, "node_modules", "prisma", "package.json"), "utf8")) as { bin: { prisma: string } };
  const result = spawnSync("node", [join(root, "node_modules", "prisma", pkg.bin.prisma), ...args, "--config", configPath], {
    cwd: exampleDir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: urlFor(names.main), SHADOW_DATABASE_URL: urlFor(names.shadow), PRISMA_HIDE_UPDATE_MESSAGE: "1", CI: "1" },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

const migrationDirs = () => readdirSync(join(exampleDir, "prisma", "migrations")).filter((n) => /^\d+_/.test(n)).sort();

before(async () => {
  if (!PG_URL) return;
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  for (const name of Object.values(names)) await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  config = prismaConfigPath();
  ctx = makeApp(urlFor(names.main));
});
after(async () => {
  if (!PG_URL) return;
  await ctx?.close();
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});

test("prisma migrate dev applies Prisma's migrations next to Inferlo's tables and keeps Inferlo's data", { skip }, async () => {
  // Inferlo's side, deployed first with its own migration file (what inferlo db migrate --apply runs).
  const plan = planMigration([Reminder]);
  await applyMigrations(ctx.app.db, [{ name: "0001_reminders", sql: plan.statements.join(";\n") }]);
  await ctx.app.db.crm_reminders.insert({ invoiceId: 1, message: "Kept" });

  const before = migrationDirs();
  const dev = prisma(["migrate", "dev"]);
  assert.equal(dev.status, 0, dev.output);
  assert.doesNotMatch(dev.output, /reset/i, dev.output);
  // No new migration: Inferlo's tables are not drift, and Prisma's own tables come from its migration files.
  assert.deepEqual(migrationDirs(), before);
  const tables = await ctx.app.db.$sql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
  assert.deepEqual(tables.map((r) => r.table_name), ["_prisma_migrations", "crm_customers", "crm_invoices", "crm_reminders", "inferlo_migrations"]);
  assert.deepEqual((await ctx.app.db.crm_reminders.findMany()).map((r) => r.message), ["Kept"]);

  // Prisma's client and Inferlo then work on the tables each created.
  const customer = await ctx.prisma.customer.create({ data: { name: "Acme" } });
  await ctx.prisma.invoice.create({ data: { customerId: customer.id, cents: 1200 } });
  assert.equal(await ctx.prisma.invoice.count(), 1);

  const again = prisma(["migrate", "dev"]);
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /Already in sync/i);
  const status = prisma(["migrate", "status"]);
  assert.equal(status.status, 0, status.output);
  assert.match(status.output, /up to date/i);
});

test("without tables.external, prisma migrate dev sees Inferlo's tables as drift and asks for a reset", { skip }, () => {
  // The same config without tables.external, written next to the generated client so that `prisma/config` resolves
  // from the repository's node_modules, with its paths pointing at the same files.
  const source = readFileSync(config, "utf8");
  const dir = join(exampleDir, "generated", `no-external-${suffix}`);
  mkdirSync(dir, { recursive: true });
  const withoutExternal = source
    .replace(/  tables: \{[\s\S]*?\n  \},\n/, "")
    .replace(/(schema|path): "([^"]+)"/g, (_m, key: string, file: string) => `${key}: "${relative(dir, resolve(dirname(config), file))}"`);
  assert.doesNotMatch(withoutExternal, /external: \[/);
  const path = join(dir, "prisma.config.ts");
  writeFileSync(path, withoutExternal);
  try {
    const dev = prisma(["migrate", "dev", "--create-only", "--name", "unwanted"], path);
    assert.notEqual(dev.status, 0, dev.output);
    assert.match(dev.output, /crm_reminders/);
    assert.match(dev.output, /reset/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!migrationDirs().some((n) => n.endsWith("_unwanted")));
});

test("Inferlo's sync and migrations leave Prisma's tables alone", { skip }, async () => {
  // Inferlo plans changes to its own models only: no statement for Prisma's tables or _prisma_migrations.
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => /"crm_reminders"/.test(s) && !/crm_customers|crm_invoices|_prisma_migrations|DROP/.test(s)), statements.join("\n"));
  const next = planMigration([Reminder], planMigration([Reminder]).snapshot, { allowDrop: true });
  assert.deepEqual(next.statements, []);
});
