/**
 * Builds llms-full.txt from README.md and docs/*.md, and checks it is up to date with --check.
 */
import { readFile, writeFile } from "node:fs/promises";

const order = ["getting-started", "comparison", "config", "schema", "database", "routes", "websockets", "auth", "ai", "jobs", "caching", "storage", "redis", "modules", "services", "mcp", "cli", "testing", "integrations", "migrate-from-express", "migrate-from-nestjs", "migrate-from-hono", "migrate-from-koa", "migrate-from-fastify", "security", "observability", "deploy", "performance", "support", "errors"];
const root = new URL("..", import.meta.url);

const parts = [`# Inferlo: full documentation\n\nGenerated from README.md and docs/. Source: https://github.com/BrowserlessAPI/Inferlo\n`];
parts.push(await readFile(new URL("README.md", root), "utf8"));
for (const name of order) parts.push(await readFile(new URL(`docs/${name}.md`, root), "utf8"));
const output = parts.map((p) => p.trim()).join("\n\n---\n\n") + "\n";

const target = new URL("llms-full.txt", root);
if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== output) {
    console.error("llms-full.txt is out of date. Run: npm run llms");
    process.exit(1);
  }
  console.log("llms-full.txt is up to date.");
} else {
  await writeFile(target, output);
  console.log(`Wrote llms-full.txt (${output.length} characters).`);
}
