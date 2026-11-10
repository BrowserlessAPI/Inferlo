// Prisma's config for this app (Prisma 7; generate.ts derives the Prisma 6 form). Prisma Migrate and Inferlo share
// one database, so Prisma is told which tables are Inferlo's: `prisma migrate dev` then neither reports them as
// drift nor asks to reset the database, and never writes a migration that drops them.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "", shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL },
  experimental: { externalTables: true },
  tables: {
    external: [
      // Inferlo's models (model("crm_reminders", ...)): add each new model here.
      "public.crm_reminders",
      // Inferlo's own tables: migration records, and the database stores for jobs, cache and rate limits.
      "public.inferlo_migrations",
      "public.inferlo_jobs",
      "public.inferlo_cache",
      "public.inferlo_rate_limits",
    ],
  },
});
