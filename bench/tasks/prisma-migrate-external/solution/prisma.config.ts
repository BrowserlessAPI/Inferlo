import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "", shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL },
  experimental: { externalTables: true },
  tables: {
    external: [
      // Inferlo's models
      "public.users",
      "public.api_keys",
      "public.notes",
      "public.reminders",
      // Inferlo's own tables
      "public.inferlo_migrations",
      "public.inferlo_jobs",
    ],
  },
});
