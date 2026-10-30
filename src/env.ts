/**
 * Read environment variables on Node, Bun, Deno and Workers, with clear errors.
 *
 *   env("DATABASE_URL")                  // required string
 *   env("PORT", { default: "3000" })     // optional with default
 *   env.int("PORT", { default: 3000 })
 *   env.bool("DEBUG", { default: false })
 */
import { KairoError } from "./errors.ts";

let overrides: Record<string, string | undefined> | undefined;

/** Use a fixed set of variables (tests, Cloudflare Workers bindings). */
export function setEnv(values: Record<string, string | undefined> | undefined): void {
  overrides = values;
}

function read(name: string): string | undefined {
  if (overrides && name in overrides) return overrides[name];
  const g = globalThis as { process?: { env?: Record<string, string | undefined> }; Deno?: { env: { get(n: string): string | undefined } } };
  if (g.process?.env) return g.process.env[name];
  if (g.Deno) {
    try {
      return g.Deno.env.get(name);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function missing(name: string): KairoError {
  return new KairoError("KR7001", `Environment variable ${name} is not set.`, {
    fix: `Set ${name} in your environment or .env file, or pass a default: env("${name}", { default: "..." }).`,
  });
}

interface EnvFn {
  (name: string): string;
  (name: string, options: { default: string }): string;
  (name: string, options: { optional: true }): string | undefined;
  int(name: string, options?: { default?: number }): number;
  bool(name: string, options?: { default?: boolean }): boolean;
}

export const env: EnvFn = Object.assign(
  (name: string, options: { default?: string; optional?: boolean } = {}): any => {
    const value = read(name);
    if (value !== undefined && value !== "") return value;
    if (options.default !== undefined) return options.default;
    if (options.optional) return undefined;
    throw missing(name);
  },
  {
    int(name: string, options: { default?: number } = {}): number {
      const value = read(name);
      if (value === undefined || value === "") {
        if (options.default !== undefined) return options.default;
        throw missing(name);
      }
      const n = Number(value);
      if (!Number.isInteger(n)) throw new KairoError("KR7002", `Environment variable ${name} must be a whole number, got "${value}".`);
      return n;
    },
    bool(name: string, options: { default?: boolean } = {}): boolean {
      const value = read(name)?.toLowerCase();
      if (value === undefined || value === "") {
        if (options.default !== undefined) return options.default;
        throw missing(name);
      }
      if (["1", "true", "yes", "on"].includes(value)) return true;
      if (["0", "false", "no", "off"].includes(value)) return false;
      throw new KairoError("KR7002", `Environment variable ${name} must be true or false, got "${value}".`);
    },
  },
);
