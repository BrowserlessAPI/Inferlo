/**
 * A model is one schema that becomes a database table, validation for create and update,
 * TypeScript types and JSON Schema.
 *
 *   export const Ticket = model("tickets", {
 *     title: t.string().max(200),
 *     priority: t.enum(["low", "normal", "urgent"]).default("normal"),
 *   })
 *
 * Every model gets id (uuid), createdAt and updatedAt automatically.
 *
 * Tenant-scoped models (multi-tenant apps) also get tenantId, set from the signed-in user:
 *
 *   export const Ticket = model("tickets", { title: t.string() }, { tenant: true })
 */
import { InferloError } from "./errors.ts";
import { ObjectSchema, Schema, t, type Def, type Shape, type ShapeInput, type ShapeOutput, type PartialShape } from "./schema.ts";

const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,62}$/;
const RESERVED = new Set(["id", "createdAt", "updatedAt"]);

function system(schema: Schema<any, any>, kind: Def["system"]): Schema<any, any> {
  return new Schema({ ...schema.def, system: kind });
}

export type SystemShape = {
  id: Schema<string>;
  createdAt: Schema<Date, Date | string>;
  updatedAt: Schema<Date, Date | string>;
};

/** Options of model(). */
export interface ModelOptions {
  /**
   * true: the table belongs to tenants (organisations, workspaces, customers). Every row gets a
   * tenantId column, and ctx.db filters every query by and stamps every insert with the current
   * tenant (auth.tenant(user), default user.tenantId). Unique fields are unique per tenant.
   */
  tenant?: boolean;
}

/** Longest tenant id Inferlo accepts. */
export const MAX_TENANT_ID = 200;

export type TenantShape = { tenantId: Schema<string> };

export class Model<N extends string = string, S extends Shape = Shape, T extends boolean = false> {
  /** Table name, also the property name on `db` (db.tickets). */
  readonly name: N;
  /** Fields you defined. */
  readonly fields: S;
  /** Full row schema including id, createdAt and updatedAt (and tenantId on tenant-scoped models). */
  readonly row: ObjectSchema<SystemShape & S & (T extends true ? TenantShape : {})>;
  /** True when the model is tenant-scoped (model(name, fields, { tenant: true })). */
  readonly tenant: T;
  /** Input schema for inserts. Fields with defaults or .optional() may be left out. */
  readonly create: ObjectSchema<S>;
  /** Input schema for updates. Every field optional. */
  readonly update: ObjectSchema<PartialShape<S>>;

  /** Type-only: the row type. Prefer Row<typeof Model>. */
  declare readonly $row: ShapeOutput<SystemShape & S & (T extends true ? TenantShape : {})>;
  declare readonly $create: ShapeInput<S>;

  constructor(name: N, fields: S, options: ModelOptions = {}) {
    if (!TABLE_NAME.test(name)) {
      throw new InferloError("IL4005", `Model name "${name}" is not a valid table name.`, {
        fix: 'Use lowercase letters, digits and underscores, starting with a letter, e.g. model("support_tickets", {...}).',
      });
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new InferloError("IL4026", `The options of model "${name}" must be an object.`, { fix: `Pass model("${name}", { ...fields }, { tenant: true }), or leave the options out.` });
    }
    for (const key of Object.keys(options)) {
      if (key !== "tenant") {
        throw new InferloError("IL4026", `Unknown option "${key}" in model "${name}".`, { fix: "model() takes one option: { tenant: true }." });
      }
    }
    if (options.tenant !== undefined && typeof options.tenant !== "boolean") {
      throw new InferloError("IL4026", `The tenant option of model "${name}" must be true or false.`, { fix: `Use model("${name}", { ...fields }, { tenant: true }).` });
    }
    const tenant = options.tenant === true;
    for (const key of Object.keys(fields)) {
      if (tenant && key === "tenantId") {
        throw new InferloError("IL4006", `Model "${name}" defines "tenantId", which Inferlo adds to tenant-scoped models.`, {
          fix: 'Remove "tenantId" from the model. With { tenant: true } every row already has tenantId, set from the current tenant.',
        });
      }
      if (RESERVED.has(key)) {
        throw new InferloError("IL4006", `Model "${name}" defines "${key}", which Inferlo adds automatically.`, {
          fix: `Remove "${key}" from the model. Every model already has id, createdAt and updatedAt.`,
        });
      }
      if (!FIELD_NAME.test(key)) {
        throw new InferloError("IL4005", `Field "${name}.${key}" is not a valid field name.`, {
          fix: "Use camelCase letters and digits, e.g. ownerId. Inferlo stores it as owner_id.",
        });
      }
    }
    this.name = name;
    this.tenant = tenant as T;
    this.create = t.object(fields);
    this.update = this.create.partial();
    // tenantId is a column like the others for the adapters, migrations and describe(), but never input.
    this.fields = (tenant
      ? { ...fields, tenantId: system(t.string().min(1).max(MAX_TENANT_ID).index().describe("Set automatically from the current tenant"), "tenantId") }
      : fields) as S;
    const systemShape: SystemShape = {
      id: system(t.uuid(), "id"),
      createdAt: system(t.date(), "createdAt"),
      updatedAt: system(t.date(), "updatedAt"),
    };
    this.row = t.object({ ...systemShape, ...this.fields } as SystemShape & S) as never;
  }

  /** Input schema with only some fields, e.g. for a route body: Ticket.pick("title", "body"). */
  pick<K extends keyof S & string>(...keys: K[]): ObjectSchema<Pick<S, K>> {
    return this.create.pick(...keys);
  }

  /** Input schema without some fields, e.g. Ticket.omit("ownerId"). */
  omit<K extends keyof S & string>(...keys: K[]): ObjectSchema<Omit<S, K>> {
    return this.create.omit(...keys);
  }
}

export type AnyModel = Model<string, any, boolean>;

/** Row type of a model: Row<typeof Ticket>. */
export type Row<M extends AnyModel> = M["$row"];
/** Insert input type of a model. */
export type CreateInput<M extends AnyModel> = M["$create"];
/** Update input type of a model. */
export type UpdateInput<M extends AnyModel> = Partial<M["$create"]>;

export function model<const N extends string, S extends Shape>(name: N, fields: S): Model<N, S>;
export function model<const N extends string, S extends Shape, const O extends ModelOptions>(name: N, fields: S, options: O): Model<N, S, O["tenant"] extends true ? true : false>;
export function model(name: string, fields: Shape, options?: ModelOptions): AnyModel {
  return new Model(name, fields, options) as AnyModel;
}

/** camelCase field name to snake_case column name. */
export function columnName(field: string): string {
  return field.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}
