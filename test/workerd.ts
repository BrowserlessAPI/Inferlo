/**
 * Runs Inferlo code in workerd, the Cloudflare Workers runtime, through Miniflare (tests only).
 * The entry file and every module it imports statically are loaded as they are, with their TypeScript types
 * stripped, so the test runs the source in the Workers runtime without a bundler.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import * as nodeModule from "node:module";

export interface WorkerModule {
  type: "ESModule";
  path: string;
  contents: string;
}

const IMPORT = /(?:^|[;\n])\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/g;

// Node.js 22.13 and newer; Bun has no stripTypeScriptTypes (the workerd tests are skipped there).
function strip(source: string): string {
  const fn = (nodeModule as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes;
  if (!fn) throw new Error("Running TypeScript in workerd needs Node.js 22.13 or newer (module.stripTypeScriptTypes).");
  return fn(source);
}

/** The entry file and every relative module it imports statically, as Miniflare modules. Dynamic imports are left out. */
export function workerModules(entry: string, root: string): WorkerModule[] {
  const modules = new Map<string, WorkerModule>();
  const visit = (file: string) => {
    if (modules.has(file)) return;
    const source = readFileSync(file, "utf8");
    const contents = file.endsWith(".ts") ? strip(source) : source;
    modules.set(file, { type: "ESModule", path: path.relative(root, file), contents });
    for (const match of contents.matchAll(IMPORT)) visit(path.resolve(path.dirname(file), match[1]!));
  };
  visit(path.resolve(entry));
  return [...modules.values()];
}
