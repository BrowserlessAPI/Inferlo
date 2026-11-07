import { defineConfig, defineEntity, p } from "@mikro-orm/postgresql";
import { models } from "./models.ts";

// The older part of the app keeps using MikroORM on the same Postgres database.
export const Project = defineEntity({
  name: "Project",
  tableName: "pm_projects",
  properties: {
    id: p.integer().primary(),
    name: p.string().length(200),
  },
});

export const config = defineConfig({
  clientUrl: process.env.DATABASE_URL,
  entities: [Project],
  // MikroORM's schema:update and migrations would drop every table that is not one of its entities.
  schemaGenerator: { skipTables: [...models.map((m) => m.name), /^inferlo_/, "audit_log"] },
});

export default config;
