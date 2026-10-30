# Schemas

`t` builds schemas. One schema gives you runtime validation, a TypeScript type, JSON Schema (for OpenAPI, MCP tools and AI structured output) and a database column.

```ts
import { t, type Infer } from "kairojs";

const Signup = t.object({
  email: t.email(),
  name: t.string().min(1).max(80),
  plan: t.enum(["free", "pro"]).default("free"),
  referral: t.string().optional(),
});

type Signup = Infer<typeof Signup>;
// { email: string; name: string; plan: "free" | "pro"; referral?: string }
```

## Types

| Builder | TypeScript | Postgres column |
|---|---|---|
| `t.string()` | `string` | `text`, or `varchar(n)` with `.max(n)` |
| `t.text()` | `string` | `text` |
| `t.email()` | `string` | `text` |
| `t.url()` | `string` (http/https only) | `text` |
| `t.uuid()` | `string` | `uuid` |
| `t.ref("users")` | `string` (id of a row) | `uuid` + foreign key + index |
| `t.int()` | `number` (whole) | `integer` |
| `t.number()` | `number` | `double precision` |
| `t.boolean()` | `boolean` | `boolean` |
| `t.date()` | `Date` (accepts ISO strings) | `timestamptz` |
| `t.enum(["a", "b"])` | `"a" \| "b"` | `text` + check constraint |
| `t.literal("x")` | `"x"` | `text` |
| `t.array(t.string())` | `string[]` | `jsonb` |
| `t.object({...})` | object | `jsonb` |
| `t.json<T>()` | `T` | `jsonb` |
| `t.any()` | `unknown` | `jsonb` |

## Modifiers

| Modifier | Effect |
|---|---|
| `.optional()` | May be left out |
| `.nullable()` | May be `null` |
| `.default(value)` | Used when left out. Pass a function for fresh values: `.default(() => [])` |
| `.min(n)` / `.max(n)` | Length for strings and arrays, value for numbers |
| `.regex(/.../)` | Strings must match |
| `.describe("...")` | Shown in OpenAPI, MCP tools and AI prompts |
| `.unique()` / `.index()` | Database unique index / index |

Object schemas also have `.pick(...)`, `.omit(...)`, `.partial()`, `.extend({...})` and `.strip()`.

## Unknown keys are rejected

Objects reject fields that are not in the schema, with a hint:

```
Unknown field "titel". Did you mean "title"?
```

This catches typos and invented fields early. Call `.strip()` to drop unknown keys silently instead. Query strings always ignore unknown keys.

## Validating

```ts
Signup.parse(input);        // returns typed data or throws ValidationError (KR1001, HTTP 422)
Signup.safeParse(input);    // { ok: true, value } or { ok: false, issues }
Signup.toJSONSchema();      // JSON Schema object
```

Pass `{ coerce: true }` to convert strings to numbers, booleans and arrays (Kairo does this automatically for query strings and path parameters).
