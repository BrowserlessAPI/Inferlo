import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { models } from "../src/models.ts";

// The Prisma CLI is not installed in the benchmark project, so the config is checked as text: Prisma reads
// tables.external as exact "schema.table" names, behind experimental.externalTables.
const path = new URL("../prisma.config.ts", import.meta.url);

test("prisma.config.ts lists every Inferlo table as external", () => {
  assert.ok(existsSync(path), "prisma.config.ts exists in the project root");
  const source = readFileSync(path, "utf8").replace(/\/\/.*$/gm, "");
  assert.match(source, /from\s+["']prisma\/config["']/);
  assert.match(source, /defineConfig\s*\(/);
  assert.match(source, /externalTables\s*:\s*true/, "experimental: { externalTables: true }");
  assert.match(source, /process\.env\.DATABASE_URL/);
  assert.match(source, /process\.env\.SHADOW_DATABASE_URL/);
  const block = /tables\s*:\s*\{[\s\S]*?external\s*:\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(block, "tables: { external: [...] }");
  const listed = new Set([...block[1]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]));
  const expected = [...models.map((m) => `public.${m.name}`), "public.inferlo_migrations", "public.inferlo_jobs"];
  for (const name of expected) assert.ok(listed.has(name), `${name} is external`);
  for (const name of listed) assert.match(name!, /^public\.[a-z_][a-z0-9_]*$/, `${name} is an exact schema.table name`);
});
