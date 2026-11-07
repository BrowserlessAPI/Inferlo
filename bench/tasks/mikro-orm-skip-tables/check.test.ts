import assert from "node:assert/strict";
import { test } from "node:test";

test("MikroORM's schema generator skips the Inferlo app's tables, and only those", async () => {
  const { config } = await import("../src/mikro-orm.config.ts");
  const { models } = await import("../src/models.ts");
  const skip = (config as { schemaGenerator?: { skipTables?: (string | RegExp)[] } }).schemaGenerator?.skipTables ?? [];
  // MikroORM matches skipTables against the table name, with or without its schema.
  const skipped = (table: string) => skip.some((rule) => (typeof rule === "string" ? rule === table || rule === `public.${table}` : rule.test(table) || rule.test(`public.${table}`)));
  for (const model of models) assert.ok(skipped(model.name), `the ${model.name} model's table is skipped`);
  for (const table of ["inferlo_jobs", "inferlo_rate_limits", "inferlo_cache", "inferlo_migrations", "audit_log"]) assert.ok(skipped(table), `Inferlo's ${table} table is skipped`);
  assert.ok(!skipped("pm_projects"), "MikroORM still manages its own tables");
  assert.ok(!skipped("pm_tasks"), "and tables of its entities added later");
});
