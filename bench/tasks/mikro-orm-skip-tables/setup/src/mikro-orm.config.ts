import { defineConfig, defineEntity, p } from "@mikro-orm/postgresql";

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
});

export default config;
