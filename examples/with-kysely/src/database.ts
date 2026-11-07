// The existing Kysely app's database types and migrations. Kysely's Migrator keeps managing these
// tables; Inferlo never touches them.
import { sql, type ColumnType, type Generated, type Kysely } from "kysely";

export interface Database {
  warehouses: { id: Generated<number>; name: string };
  shipments: { id: Generated<number>; warehouse_id: number; reference: string; created_at: ColumnType<Date, never, never> };
}

/** A Kysely migration (the shape of Kysely's Migration type, which 0.29 moved to "kysely/migration"). */
export interface KyselyMigration {
  up(db: Kysely<any>): Promise<void>;
  down?(db: Kysely<any>): Promise<void>;
}

export const migrations: Record<string, KyselyMigration> = {
  "2025_01_01_warehouses": {
    async up(db: Kysely<any>) {
      await db.schema.createTable("warehouses").addColumn("id", "serial", (c) => c.primaryKey()).addColumn("name", "text", (c) => c.notNull()).execute();
      await db.schema
        .createTable("shipments")
        .addColumn("id", "serial", (c) => c.primaryKey())
        .addColumn("warehouse_id", "integer", (c) => c.notNull().references("warehouses.id"))
        .addColumn("reference", "text", (c) => c.notNull().unique())
        .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable("shipments").execute();
      await db.schema.dropTable("warehouses").execute();
    },
  },
};
