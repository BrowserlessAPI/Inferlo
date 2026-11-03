/**
 * Inferlo schemas. One definition gives you runtime validation, TypeScript types,
 * JSON Schema (for OpenAPI, MCP tools and AI structured output) and database columns.
 *
 *   const User = t.object({ name: t.string().max(80), age: t.int().optional() })
 *   type User = Infer<typeof User>
 */
import { InferloError, didYouMean } from "./errors.ts";

export type Kind =
  | "string"
  | "text"
  | "email"
  | "url"
  | "uuid"
  | "ref"
  | "number"
  | "int"
  | "boolean"
  | "date"
  | "enum"
  | "literal"
  | "json"
  | "array"
  | "object"
  | "any";

export interface Def {
  kind: Kind;
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  pattern?: RegExp;
  values?: readonly (string | number | boolean)[];
  item?: AnySchema;
  shape?: Shape;
  unknownKeys?: "strict" | "strip";
  refTable?: string;
  onDelete?: "restrict" | "cascade" | "set null";
  description?: string;
  example?: unknown;
  unique?: boolean;
  index?: boolean;
  /** Filled in by the framework (id, createdAt, updatedAt). Never accepted as input. */
  system?: "id" | "createdAt" | "updatedAt";
}

export interface Issue {
  path: (string | number)[];
  code: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface ParseOptions {
  /** Convert strings to numbers, booleans and dates (used for query strings and path params). */
  coerce?: boolean;
}

export class ValidationError extends InferloError {
  readonly issues: Issue[];
  constructor(issues: Issue[], where = "input") {
    const first = issues[0];
    const summary = first ? `${first.path.length ? first.path.join(".") + ": " : ""}${first.message}` : "invalid";
    super("IL1001", `Invalid ${where}. ${summary}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`, {
      status: 422,
      details: issues,
      fix: "Send data that matches the schema. Each entry in details names the exact path and problem.",
    });
    this.issues = issues;
  }
}

export type JSONSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------------------------

export type AnySchema = Schema<any, any>;
export type Shape = Record<string, AnySchema>;

/** The parsed (output) type of a schema. */
export type Infer<S> = S extends Schema<infer O, any> ? O : never;
/** The accepted input type of a schema (fields with defaults are optional). */
export type InferInput<S> = S extends Schema<any, infer I> ? I : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? K : never }[keyof T];
type Objectify<T> = Simplify<{ [K in Exclude<keyof T, OptionalKeys<T>>]: T[K] } & { [K in OptionalKeys<T>]?: T[K] }>;

export type ShapeOutput<S extends Shape> = Objectify<{ [K in keyof S]: Infer<S[K]> }>;
export type ShapeInput<S extends Shape> = Objectify<{ [K in keyof S]: InferInput<S[K]> }>;
export type PartialShape<S extends Shape> = { [K in keyof S]: Schema<Infer<S[K]> | undefined, InferInput<S[K]> | undefined> };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

export class Schema<Out, In = Out> {
  readonly def: Def;
  /** Type-only markers. Use Infer<typeof schema> instead of reading these. */
  declare readonly _output: Out;
  declare readonly _input: In;

  constructor(def: Def) {
    this.def = def;
  }

  protected with(changes: Partial<Def>): this {
    const Ctor = this.constructor as new (def: Def) => this;
    return new Ctor({ ...this.def, ...changes });
  }

  /** Field may be left out. */
  optional(): Schema<Out | undefined, In | undefined> {
    return this.with({ optional: true }) as never;
  }

  /** Field may be null. */
  nullable(): Schema<Out | null, In | null> {
    return this.with({ nullable: true }) as never;
  }

  /** Value used when the field is left out. Pass a function for values like dates. */
  default(value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>)): Schema<Exclude<Out, undefined>, In | undefined> {
    return this.with({ hasDefault: true, defaultValue: value, optional: false }) as never;
  }

  /** Minimum length (strings, arrays) or minimum value (numbers). */
  min(n: number): this {
    return this.with({ min: n });
  }

  /** Maximum length (strings, arrays) or maximum value (numbers). */
  max(n: number): this {
    return this.with({ max: n });
  }

  /** Strings must match this regular expression. */
  regex(pattern: RegExp): this {
    return this.with({ pattern });
  }

  /** Shown in OpenAPI, MCP tool definitions and AI prompts. */
  describe(description: string): this {
    return this.with({ description });
  }

  example(value: Out): this {
    return this.with({ example: value });
  }

  /** Database: unique column. */
  unique(): this {
    return this.with({ unique: true });
  }

  /** Database: add an index on this column. */
  index(): this {
    return this.with({ index: true });
  }

  /** Validate and return typed data, or throw ValidationError (HTTP 422). */
  parse(input: unknown, options?: ParseOptions): Out {
    const result = this.safeParse(input, options);
    if (!result.ok) throw new ValidationError(result.issues);
    return result.value;
  }

  /** Validate without throwing. */
  safeParse(input: unknown, options: ParseOptions = {}): ParseResult<Out> {
    const issues: Issue[] = [];
    const value = check(this, input, [], issues, options);
    return issues.length ? { ok: false, issues } : { ok: true, value: value as Out };
  }

  /** JSON Schema (draft 2020-12 compatible) for OpenAPI, MCP and AI structured output. */
  toJSONSchema(): JSONSchema {
    return toJSONSchema(this);
  }
}

export class ObjectSchema<S extends Shape> extends Schema<ShapeOutput<S>, ShapeInput<S>> {
  get shape(): S {
    return this.def.shape as S;
  }

  /** Keep only some fields. */
  pick<K extends keyof S & string>(...keys: K[]): ObjectSchema<Pick<S, K>> {
    const shape: Shape = {};
    for (const key of keys) {
      if (!(key in this.shape)) {
        throw new InferloError("IL1003", `pick(): field "${key}" does not exist.${didYouMean(key, Object.keys(this.shape))}`, {
          fix: `Use one of: ${Object.keys(this.shape).join(", ")}`,
        });
      }
      shape[key] = this.shape[key]!;
    }
    return new ObjectSchema<Pick<S, K>>({ ...this.def, shape });
  }

  /** Drop some fields. */
  omit<K extends keyof S & string>(...keys: K[]): ObjectSchema<Omit<S, K>> {
    const shape: Shape = { ...this.shape };
    for (const key of keys) delete shape[key];
    return new ObjectSchema<Omit<S, K>>({ ...this.def, shape });
  }

  /** Every field optional (for PATCH bodies). Defaults are not applied. */
  partial(): ObjectSchema<PartialShape<S>> {
    const shape: Shape = {};
    for (const [key, field] of Object.entries(this.shape)) {
      shape[key] = new (field.constructor as new (def: Def) => AnySchema)({ ...field.def, optional: true, hasDefault: false });
    }
    return new ObjectSchema<PartialShape<S>>({ ...this.def, shape });
  }

  /** Add fields. */
  extend<E extends Shape>(extra: E): ObjectSchema<Omit<S, keyof E> & E> {
    return new ObjectSchema<Omit<S, keyof E> & E>({ ...this.def, shape: { ...this.shape, ...extra } });
  }

  /** Silently drop unknown keys instead of rejecting them (the default is to reject). */
  strip(): this {
    return this.with({ unknownKeys: "strip" });
  }
}

export class ArraySchema<I extends AnySchema> extends Schema<Infer<I>[], InferInput<I>[]> {
  get item(): I {
    return this.def.item as I;
  }
}

/** t.ref("users"): the id of a row in another table. The table name is kept in the type for include. */
export class RefSchema<Table extends string, Out = string, In = Out> extends Schema<Out, In> {
  /** Type-only marker: the referenced table. */
  declare readonly _ref: Table;

  override optional(): RefSchema<Table, Out | undefined, In | undefined> {
    return this.with({ optional: true }) as never;
  }

  override nullable(): RefSchema<Table, Out | null, In | null> {
    return this.with({ nullable: true }) as never;
  }

  override default(value: Exclude<Out, undefined> | (() => Exclude<Out, undefined>)): RefSchema<Table, Exclude<Out, undefined>, In | undefined> {
    return this.with({ hasDefault: true, defaultValue: value, optional: false }) as never;
  }
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

function base(kind: Kind, extra: Partial<Def> = {}): Def {
  return { kind, optional: false, nullable: false, hasDefault: false, ...extra };
}

export const t = {
  /** Short text. Stored as text (or varchar(max) when .max() is set). */
  string: () => new Schema<string>(base("string")),
  /** Long text such as a post body. */
  text: () => new Schema<string>(base("text")),
  email: () => new Schema<string>(base("email", { max: 254 })),
  url: () => new Schema<string>(base("url", { max: 2048 })),
  uuid: () => new Schema<string>(base("uuid")),
  number: () => new Schema<number>(base("number")),
  /** Whole number. */
  int: () => new Schema<number>(base("int")),
  boolean: () => new Schema<boolean>(base("boolean")),
  /** Accepts a Date or an ISO 8601 string, always returns a Date. */
  date: () => new Schema<Date, Date | string>(base("date")),
  /** One of a fixed list of strings: t.enum(["low", "normal", "urgent"]). */
  enum: <const V extends readonly [string, ...string[]]>(values: V) => new Schema<V[number]>(base("enum", { values })),
  literal: <const V extends string | number | boolean>(value: V) => new Schema<V>(base("literal", { values: [value] })),
  /** Any JSON value. Stored as jsonb. */
  json: <T = unknown>() => new Schema<T>(base("json")),
  array: <I extends AnySchema>(item: I) => new ArraySchema<I>(base("array", { item })),
  object: <S extends Shape>(shape: S) => new ObjectSchema<S>(base("object", { shape, unknownKeys: "strict" })),
  /** Id of a row in another model's table: t.ref("users"). */
  ref: <const Table extends string>(table: Table, options: { onDelete?: "restrict" | "cascade" | "set null" } = {}) =>
    new RefSchema<Table>(base("ref", { refTable: table, onDelete: options.onDelete ?? "restrict" })),
  any: () => new Schema<unknown>(base("any", { optional: true })),
};

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  return typeof value;
}

function coerceValue(kind: Kind, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if ((kind === "number" || kind === "int") && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (kind === "boolean") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  if (kind === "literal" || kind === "enum") return value;
  return value;
}

function check(schema: AnySchema, raw: unknown, path: (string | number)[], issues: Issue[], options: ParseOptions): unknown {
  const def = schema.def;
  let value = raw;

  if (value === undefined) {
    if (def.hasDefault) {
      const d = def.defaultValue;
      return typeof d === "function" ? (d as () => unknown)() : structuredCloneSafe(d);
    }
    if (def.optional) return undefined;
    issues.push({ path, code: "required", message: "Required." });
    return undefined;
  }
  if (value === null) {
    if (def.nullable) return null;
    issues.push({ path, code: "invalid_type", message: "Expected a value, got null." });
    return undefined;
  }
  if (options.coerce) value = coerceValue(def.kind, value);

  const fail = (code: string, message: string) => {
    issues.push({ path, code, message });
    return undefined;
  };

  switch (def.kind) {
    case "any":
    case "json":
      return value;

    case "string":
    case "text":
    case "email":
    case "url":
    case "uuid":
    case "ref": {
      if (typeof value !== "string") return fail("invalid_type", `Expected a string, got ${describeType(value)}.`);
      if (def.kind === "email" && !EMAIL.test(value)) return fail("invalid_email", "Expected an email address.");
      if ((def.kind === "uuid" || def.kind === "ref") && !UUID.test(value)) return fail("invalid_uuid", "Expected a UUID.");
      if (def.kind === "url") {
        try {
          const u = new URL(value);
          if (u.protocol !== "http:" && u.protocol !== "https:") return fail("invalid_url", "Expected an http or https URL.");
        } catch {
          return fail("invalid_url", "Expected a URL.");
        }
      }
      if (def.min !== undefined && value.length < def.min) return fail("too_short", `Must be at least ${def.min} characters.`);
      if (def.max !== undefined && value.length > def.max) return fail("too_long", `Must be at most ${def.max} characters.`);
      if (def.pattern && !def.pattern.test(value)) return fail("invalid_format", `Must match ${def.pattern}.`);
      return value;
    }

    case "number":
    case "int": {
      if (typeof value !== "number" || !Number.isFinite(value)) return fail("invalid_type", `Expected a number, got ${describeType(value)}.`);
      if (def.kind === "int" && !Number.isInteger(value)) return fail("invalid_type", "Expected a whole number.");
      if (def.min !== undefined && value < def.min) return fail("too_small", `Must be at least ${def.min}.`);
      if (def.max !== undefined && value > def.max) return fail("too_big", `Must be at most ${def.max}.`);
      return value;
    }

    case "boolean":
      if (typeof value !== "boolean") return fail("invalid_type", `Expected true or false, got ${describeType(value)}.`);
      return value;

    case "date": {
      let date: Date | undefined;
      if (value instanceof Date) date = value;
      else if (typeof value === "string" && ISO_DATE.test(value)) date = new Date(value);
      if (!date || Number.isNaN(date.getTime())) return fail("invalid_date", "Expected an ISO 8601 date string.");
      return date;
    }

    case "enum":
    case "literal": {
      const values = def.values ?? [];
      if (!values.includes(value as string)) {
        const hint = typeof value === "string" ? didYouMean(value, values.map(String)) : "";
        return fail("invalid_enum", `Expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}.${hint}`);
      }
      return value;
    }

    case "array": {
      if (!Array.isArray(value)) {
        if (options.coerce && typeof value === "string") value = value === "" ? [] : value.split(",");
        else return fail("invalid_type", `Expected an array, got ${describeType(value)}.`);
      }
      const list = value as unknown[];
      if (def.min !== undefined && list.length < def.min) return fail("too_short", `Must have at least ${def.min} items.`);
      if (def.max !== undefined && list.length > def.max) return fail("too_long", `Must have at most ${def.max} items.`);
      return list.map((item, i) => check(def.item!, item, [...path, i], issues, options));
    }

    case "object": {
      if (typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
        return fail("invalid_type", `Expected an object, got ${describeType(value)}.`);
      }
      const shape = def.shape ?? {};
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape)) {
        if (field.def.system && input[key] !== undefined) {
          issues.push({ path: [...path, key], code: "read_only", message: `"${key}" is set by the framework and cannot be sent.` });
          continue;
        }
        const parsed = check(field, input[key], [...path, key], issues, options);
        if (parsed !== undefined) out[key] = parsed;
      }
      if (def.unknownKeys !== "strip") {
        for (const key of Object.keys(input)) {
          if (!(key in shape) && input[key] !== undefined) {
            issues.push({
              path: [...path, key],
              code: "unknown_key",
              message: `Unknown field "${key}".${didYouMean(key, Object.keys(shape))}`,
            });
          }
        }
      }
      return out;
    }
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

// ---------------------------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------------------------

export function toJSONSchema(schema: AnySchema): JSONSchema {
  const def = schema.def;
  let out: JSONSchema;
  switch (def.kind) {
    case "string":
    case "text":
      out = { type: "string" };
      if (def.min !== undefined) out.minLength = def.min;
      if (def.max !== undefined) out.maxLength = def.max;
      if (def.pattern) out.pattern = def.pattern.source;
      break;
    case "email":
      out = { type: "string", format: "email", maxLength: def.max };
      break;
    case "url":
      out = { type: "string", format: "uri", maxLength: def.max };
      break;
    case "uuid":
    case "ref":
      out = { type: "string", format: "uuid" };
      break;
    case "number":
    case "int":
      out = { type: def.kind === "int" ? "integer" : "number" };
      if (def.min !== undefined) out.minimum = def.min;
      if (def.max !== undefined) out.maximum = def.max;
      break;
    case "boolean":
      out = { type: "boolean" };
      break;
    case "date":
      out = { type: "string", format: "date-time" };
      break;
    case "enum":
      out = { type: "string", enum: [...(def.values ?? [])] };
      break;
    case "literal":
      out = { const: def.values?.[0] };
      break;
    case "array":
      out = { type: "array", items: toJSONSchema(def.item!) };
      if (def.min !== undefined) out.minItems = def.min;
      if (def.max !== undefined) out.maxItems = def.max;
      break;
    case "object": {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const [key, field] of Object.entries(def.shape ?? {})) {
        properties[key] = toJSONSchema(field);
        if (!field.def.optional && !field.def.hasDefault) required.push(key);
      }
      out = { type: "object", properties, additionalProperties: def.unknownKeys === "strip" };
      if (required.length) out.required = required;
      break;
    }
    case "json":
    case "any":
      out = {};
      break;
  }
  if (def.nullable) {
    out = out.type ? { ...out, type: [out.type, "null"] } : { anyOf: [out, { type: "null" }] };
  }
  if (def.description) out.description = def.description;
  if (def.hasDefault && typeof def.defaultValue !== "function") out.default = def.defaultValue;
  if (def.example !== undefined) out.examples = [def.example];
  if (def.system) out.readOnly = true;
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}
