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

export class Model<N extends string = string, S extends Shape = Shape> {
  /** Table name, also the property name on `db` (db.tickets). */
  readonly name: N;
  /** Fields you defined. */
  readonly fields: S;
  /** Full row schema including id, createdAt and updatedAt. */
  readonly row: ObjectSchema<SystemShape & S>;
  /** Input schema for inserts. Fields with defaults or .optional() may be left out. */
  readonly create: ObjectSchema<S>;
  /** Input schema for updates. Every field optional. */
  readonly update: ObjectSchema<PartialShape<S>>;

  /** Type-only: the row type. Prefer Row<typeof Model>. */
  declare readonly $row: ShapeOutput<SystemShape & S>;
  declare readonly $create: ShapeInput<S>;

  constructor(name: N, fields: S) {
    if (!TABLE_NAME.test(name)) {
      throw new InferloError("IL4005", `Model name "${name}" is not a valid table name.`, {
        fix: 'Use lowercase letters, digits and underscores, starting with a letter, e.g. model("support_tickets", {...}).',
      });
    }
    for (const key of Object.keys(fields)) {
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
    this.fields = fields;
    this.create = t.object(fields);
    this.update = this.create.partial();
    const systemShape: SystemShape = {
      id: system(t.uuid(), "id"),
      createdAt: system(t.date(), "createdAt"),
      updatedAt: system(t.date(), "updatedAt"),
    };
    this.row = t.object({ ...systemShape, ...fields } as SystemShape & S);
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

export type AnyModel = Model<string, any>;

/** Row type of a model: Row<typeof Ticket>. */
export type Row<M extends AnyModel> = M["$row"];
/** Insert input type of a model. */
export type CreateInput<M extends AnyModel> = M["$create"];
/** Update input type of a model. */
export type UpdateInput<M extends AnyModel> = Partial<M["$create"]>;

export function model<const N extends string, S extends Shape>(name: N, fields: S): Model<N, S> {
  return new Model(name, fields);
}

/** camelCase field name to snake_case column name. */
export function columnName(field: string): string {
  return field.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}
