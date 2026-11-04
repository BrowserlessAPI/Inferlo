/**
 * Typed configuration, validated once at startup:
 *
 *   export const settings = config({
 *     schema: t.object({ DATABASE_URL: t.string(), PORT: t.int().default(3000) }),
 *     secrets: ["DATABASE_URL"],
 *     environments: { test: { DATABASE_URL: "memory" } },
 *   });
 *   settings.PORT // number
 *
 * Values come from environment variables (inferlo dev, inferlo worker and Bun read .env files into them),
 * then from `environments[current environment]`, then from the schema's defaults.
 */
import { readEnv } from "./env.ts";
import { InferloError, didYouMean } from "./errors.ts";
import { holdConfigSecrets } from "./redact.ts";
import { ObjectSchema, type Infer, type Shape } from "./schema.ts";

type Key<S extends Shape> = keyof S & string;

export interface ConfigOptions<S extends Shape> {
  /** One field per environment variable: t.object({ PORT: t.int().default(3000), ... }). */
  schema: ObjectSchema<S>;
  /** Variables whose values are never shown: redacted in JSON.stringify, console.log and error messages. */
  secrets?: readonly Key<S>[];
  /** Values per environment, used when the variable is not set: { test: { DATABASE_URL: "memory" } }. */
  environments?: Readonly<Record<string, Readonly<Partial<Record<Key<S>, string | number | boolean>>>>>;
  /** The current environment. Default: INFERLO_ENV, then NODE_ENV, then "development". */
  environment?: string;
}

/** Validated configuration values. Frozen; secrets are redacted when serialised or logged. */
export type Config<S extends Shape> = Readonly<Infer<ObjectSchema<S>>>;

const REDACTED = "[redacted]";
const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

function invalid(message: string, fix: string): InferloError {
  return new InferloError("IL7004", message, { fix });
}

export function config<const S extends Shape>(options: ConfigOptions<S>): Config<S> {
  const schema = options?.schema as unknown;
  if (!(schema instanceof ObjectSchema)) {
    throw invalid("config({ schema }) needs a t.object() schema with one field per environment variable.", 'Use config({ schema: t.object({ PORT: t.int().default(3000) }) }).');
  }
  const shape = schema.shape as Shape;
  const keys = Object.keys(shape);
  for (const [key, field] of Object.entries(shape)) {
    if (field.def.kind === "object") {
      throw invalid(`Config field ${key} is an object, but environment variables are text.`, "Use one field per variable, or t.json() and parse it yourself.");
    }
  }
  const secrets = new Set<string>(options.secrets ?? []);
  for (const key of secrets) {
    if (!(key in shape)) throw invalid(`Secret "${key}" is not a field of the config schema.${didYouMean(key, keys)}`, "List only fields of the schema in secrets.");
  }
  for (const [name, values] of Object.entries(options.environments ?? {})) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw invalid(`environments.${name} must be an object of variable values.`, `Use environments: { ${name}: { PORT: "3000" } }.`);
    }
    for (const key of Object.keys(values)) {
      if (!(key in shape)) throw invalid(`environments.${name}.${key} is not a field of the config schema.${didYouMean(key, keys)}`, "Add the field to the schema or remove it from environments.");
    }
  }

  const environment = options.environment ?? (readEnv("INFERLO_ENV") || readEnv("NODE_ENV") || "development");
  const preset = (options.environments?.[environment] ?? {}) as Record<string, unknown>;
  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    let value: unknown = readEnv(key);
    if (value === "") value = undefined;
    if (value === undefined) value = preset[key];
    // Same words as env.bool: 1, true, yes, on and 0, false, no, off.
    if (typeof value === "string" && shape[key]!.def.kind === "boolean") {
      const lower = value.toLowerCase();
      if (["1", "true", "yes", "on"].includes(lower)) value = true;
      else if (["0", "false", "no", "off"].includes(lower)) value = false;
    }
    if (value !== undefined) raw[key] = value;
  }

  const result = schema.safeParse(raw, { coerce: true });
  if (!result.ok) {
    const issues = result.issues.map((issue) => {
      const key = String(issue.path[0] ?? "");
      const hidden = secrets.has(key) && issue.code !== "required";
      return { key, code: issue.code, message: hidden ? "Invalid value (secret, not shown)." : issue.message };
    });
    const list = issues.map((i) => `${i.key}: ${i.message}`).join(" ");
    throw new InferloError("IL7003", `Configuration is invalid (environment "${environment}"). ${list}`, {
      fix: `Set ${[...new Set(issues.map((i) => i.key))].join(", ")} in your environment or .env file, add the value to environments.${environment}, or give the field a .default(...).`,
      details: { environment, issues },
    });
  }

  const values = result.value as Record<string, unknown>;
  const redacted = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) out[key] = secrets.has(key) && value !== undefined ? REDACTED : value;
    return out;
  };
  const settings: Record<string | symbol, unknown> = { ...values };
  Object.defineProperties(settings, {
    toJSON: { value: redacted, enumerable: false },
    toString: { value: () => `Config ${JSON.stringify(redacted())}`, enumerable: false },
    [inspectSymbol]: { value: () => redacted(), enumerable: false },
  });
  for (const value of Object.values(values)) if (Array.isArray(value)) Object.freeze(value);
  holdConfigSecrets(settings, [...secrets].map((key) => values[key]));
  return Object.freeze(settings) as unknown as Config<S>;
}
