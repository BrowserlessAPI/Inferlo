/**
 * Zod, Valibot, ArkType and any other Standard Schema library in the AI module: schemas that implement Standard
 * Schema (https://standardschema.dev) and Standard JSON Schema work as ai.generate({ output }) and as
 * tool(name, { input }), next to Inferlo's own t.* schemas.
 *
 *   import { z } from "zod";
 *   const { object } = await ai.generate({ model: "fast", prompt, output: z.object({ title: z.string() }) });
 *
 * The JSON Schema the model is shown comes from the library ("~standard".jsonSchema.input), and the model's answer
 * is validated with the library ("~standard".validate), so the result is typed by the library's output type.
 * Internal: the public surface is the StandardSchema type and the options that accept it.
 */
import { InferloError } from "../errors.ts";
import { type AnySchema, type Infer, type Issue, type JSONSchema, Schema, ValidationError, toJSONSchema } from "../schema.ts";

/** A schema from a Standard Schema library (Zod 4.2 and later, Valibot with toStandardJsonSchema, ArkType 2.1.28 and later). */
export interface StandardSchema<Output = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: unknown; readonly output: Output } | undefined;
    /** Standard JSON Schema: how the schema is described to the model (required at runtime; IL5032 or IL5013 without it). */
    readonly jsonSchema?: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined }> };

/** The output type of an Inferlo schema or a Standard Schema. */
export type InferOutput<S> = S extends AnySchema
  ? Infer<S>
  : S extends { readonly "~standard": { readonly types?: { readonly output: infer O } | undefined } }
    ? O
    : unknown;

/** How the AI module uses a schema: shown to the model as JSON Schema, and the model's value checked against it. */
export interface SchemaAdapter {
  jsonSchema: JSONSchema;
  validate(value: unknown): Promise<{ ok: true; value: unknown } | { ok: false; issues: Issue[] }>;
}

export function isStandardSchema(value: unknown): value is StandardSchema {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const std = (value as { "~standard"?: { version?: unknown; validate?: unknown } })["~standard"];
  return typeof std === "object" && std !== null && std.version === 1 && typeof std.validate === "function";
}

function issuePath(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined): (string | number)[] {
  return (path ?? []).map((p) => {
    const key = typeof p === "object" && p !== null ? p.key : p;
    return typeof key === "number" ? key : String(key);
  });
}

/**
 * The adapter for an Inferlo schema or a Standard Schema, or a description of what is wrong (for IL5032 and IL5013).
 * Standard JSON Schema is required, because the model has to be told the shape.
 */
export function schemaAdapter(schema: unknown): SchemaAdapter | string {
  if (schema instanceof Schema) {
    const s = schema as AnySchema;
    return {
      jsonSchema: toJSONSchema(s),
      async validate(value) {
        const result = s.safeParse(value);
        return result.ok ? { ok: true, value: result.value } : { ok: false, issues: result.issues };
      },
    };
  }
  if (!isStandardSchema(schema)) return "it is neither an Inferlo t.* schema nor a Standard Schema (Zod, Valibot, ArkType)";
  const std = schema["~standard"];
  const generate = std.jsonSchema?.input;
  if (typeof generate !== "function") {
    return `the ${String(std.vendor)} schema does not implement Standard JSON Schema, so its shape cannot be shown to the model (Zod 4.2 or later, ArkType 2.1.28 or later, or Valibot's toStandardJsonSchema(schema) from @valibot/to-json-schema)`;
  }
  let jsonSchema: JSONSchema;
  try {
    const generated = (generate as (options: { target: string }) => Record<string, unknown>).call(std.jsonSchema, { target: "draft-2020-12" });
    const { $schema: _ignored, ...rest } = generated;
    jsonSchema = rest as JSONSchema;
  } catch (error) {
    return `the ${String(std.vendor)} schema cannot be turned into JSON Schema (${error instanceof Error ? error.message : String(error)}); use types JSON can carry (no transforms on the input side, no functions, dates as strings)`;
  }
  return {
    jsonSchema,
    async validate(value) {
      const result = await std.validate(value);
      if (!result.issues) return { ok: true, value: result.value };
      // Array.from, not issues.map: ArkType's issues are an Array subclass, and map would build another one.
      return { ok: false, issues: Array.from(result.issues, (i) => ({ path: issuePath(i.path), code: "invalid", message: i.message })) };
    },
  };
}

/** Validates a value with an adapter, throwing a ValidationError like t.* schemas do. */
export async function validateOrThrow(adapter: SchemaAdapter, value: unknown, where: string): Promise<unknown> {
  const result = await adapter.validate(value);
  if (result.ok) return result.value;
  throw new ValidationError(result.issues, where);
}

/** IL5032 for an ai.generate({ output }) that is not a usable schema. */
export function invalidOutputSchema(why: string): InferloError {
  return new InferloError("IL5032", `ai.generate({ output }) needs a schema: ${why}.`, {
    fix: 'Pass an Inferlo schema (output: t.object({ ... })) or a Standard Schema with JSON Schema support: z.object({ ... }) from zod 4.2+, type({ ... }) from arktype 2.1.28+, or toStandardJsonSchema(v.object({ ... })) from @valibot/to-json-schema.',
  });
}
