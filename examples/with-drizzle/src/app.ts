// An existing Drizzle app that adopts Inferlo next to it, on the same Postgres database:
// 1. One pg pool for both: Drizzle's orm and Inferlo's postgres({ pool }).
// 2. Inferlo routes read and write Drizzle's tables with the orm, imported like any module.
// 3. A new table as an Inferlo model (with migrations from inferlo db migrate), written in the same
//    transaction as a Drizzle table through tx.$pgClient().
import { eq, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bearer, createApp, model, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";
import * as schema from "./schema.ts";

// A new feature, built with Inferlo: payment reminders for Drizzle's invoices.
export const Reminder = model("reminders", {
  invoiceId: t.int().index(),
  message: t.string().min(1).max(500),
});

export function makeApp(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const orm = drizzle({ client: pool, schema });

  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  const customerTotal = route
    .get("/customers/:id/total", { params: t.object({ id: t.int() }) })
    .handle(async ({ params }) => {
      const [row] = await orm.select({ cents: sum(schema.invoices.cents).mapWith(Number) }).from(schema.invoices).where(eq(schema.invoices.customerId, params.id));
      return { customerId: params.id, cents: row?.cents ?? 0 };
    });

  // An invoice (Drizzle) and its first reminder (Inferlo) commit or roll back together.
  const createInvoice = route
    .post("/invoices", { body: t.object({ customerId: t.int(), cents: t.int().min(1), reminder: t.string().min(1).max(500) }) })
    .handle(({ body, db, status }) =>
      db.$transaction(async (tx) => {
        const txOrm = drizzle({ client: await tx.$pgClient<pg.PoolClient>(), schema });
        const [invoice] = await txOrm.insert(schema.invoices).values({ customerId: body.customerId, cents: body.cents }).returning();
        const reminder = await tx.reminders.insert({ invoiceId: invoice!.id, message: body.reminder });
        status(201);
        return { invoice, reminder };
      }),
    );

  const app = createApp({
    name: "with-drizzle",
    models: [Reminder],
    db: postgres({ pool }),
    routes: [{ customerTotal, createInvoice }],
    auth: bearer((token) => users.get(token) ?? null),
  });
  return { app, orm, pool };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof Reminder];
  }
}
