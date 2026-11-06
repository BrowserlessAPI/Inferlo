// Generates the Prisma client for this example into generated/prisma (git-ignored), as `prisma generate`
// does in a Prisma app's build. Works with Prisma 6 and 7: for Prisma 6 it writes the Prisma 6 form of
// prisma/schema.prisma (datasource url and engineType "client") to generated/schema.prisma first.
// Skips the work when the client was generated from the same schema and Prisma version.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

export function ensurePrismaClient(): void {
  const version = (JSON.parse(readFileSync(join(root, "node_modules", "prisma", "package.json"), "utf8")) as { version: string }).version;
  const major = Number(version.split(".")[0]);
  let schema = readFileSync(join(here, "prisma", "schema.prisma"), "utf8");
  let schemaPath = join(here, "prisma", "schema.prisma");
  const outDir = join(here, "generated");
  mkdirSync(outDir, { recursive: true });
  if (major < 7) {
    schema = schema
      .replace('output   = "../generated/prisma"', 'output   = "./prisma"\n  engineType = "client"')
      .replace('provider = "postgresql"', 'provider = "postgresql"\n  url      = env("DATABASE_URL")');
    schemaPath = join(outDir, "schema.prisma");
    writeFileSync(schemaPath, schema);
  }
  const stamp = `${version}\n${createHash("sha256").update(schema).digest("hex")}\n`;
  const stampPath = join(outDir, ".stamp");
  if (existsSync(join(outDir, "prisma", "client.ts")) && existsSync(stampPath) && readFileSync(stampPath, "utf8") === stamp) return;
  const result = spawnSync("node", [join(root, "node_modules", "prisma", "build", "index.js"), "generate", "--schema", schemaPath], {
    cwd: here,
    encoding: "utf8",
    // Prisma 6 reads the datasource url while generating; the client never connects with it.
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://localhost:5432/unused" },
  });
  if (result.status !== 0) throw new Error(`prisma generate failed:\n${result.stdout}\n${result.stderr}`);
  writeFileSync(stampPath, stamp);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) ensurePrismaClient();
