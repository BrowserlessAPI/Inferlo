// An existing Prisma app that adopts Inferlo next to it, on the same Postgres database:
// 1. One pg pool for both: Prisma's driver adapter (new PrismaPg(pool)) and Inferlo's postgres({ pool }).
// 2. Inferlo routes and jobs read and write Prisma's tables with the Prisma client, imported like any module.
// 3. A new table as an Inferlo model (with migrations from inferlo db migrate) next to Prisma's models.
// 4. A write that must be atomic across both runs in Inferlo's db.$transaction, writing Prisma's table with
//    parameterised SQL (tx.$sql), because Prisma's transactions keep their connection to themselves.
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { bearer, createApp, job, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";
import { PrismaClient } from "../generated/prisma/client.ts";

// A new feature, built with Inferlo: payment reminders for Prisma's invoices.
export const Reminder = model("crm_reminders", {
  invoiceId: t.int().index(),
  message: t.string().min(1).max(500),
  sentAt: t.date().optional(),
});

export function makeApp(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  // Prisma in a route: its own queries, with relations and aggregates.
  const customerTotal = route
    .get("/customers/:id/total", { params: t.object({ id: t.int() }) })
    .handle(async ({ params }) => {
      const customer = await prisma.customer.findUnique({ where: { id: params.id } });
      if (!customer) throw notFound("Customer not found");
      const { _sum } = await prisma.invoice.aggregate({ where: { customerId: params.id }, _sum: { cents: true } });
      return { customerId: customer.id, name: customer.name, cents: _sum.cents ?? 0 };
    });

  // Prisma and Inferlo in one handler: the invoice and its customer from Prisma, its reminders from Inferlo.
  const getInvoice = route
    .get("/invoices/:id", { params: t.object({ id: t.int() }) })
    .handle(async ({ params, db }) => {
      const invoice = await prisma.invoice.findUnique({ where: { id: params.id }, include: { customer: true } });
      if (!invoice) throw notFound("Invoice not found");
      const reminders = await db.crm_reminders.findMany({ where: { invoiceId: invoice.id } });
      return { id: invoice.id, cents: invoice.cents, customer: invoice.customer.name, reminders };
    });

  // An invoice (Prisma's table) and its first reminder (Inferlo) commit or roll back together.
  const createInvoice = route
    .post("/invoices", { body: t.object({ customerId: t.int(), cents: t.int().min(1), reminder: t.string().min(1).max(500) }) })
    .handle(async ({ body, db, jobs, status }) => {
      const { invoice, reminder } = await db.$transaction(async (tx) => {
        const [invoice] = await tx.$sql(`INSERT INTO crm_invoices (customer_id, cents) VALUES ($1, $2) RETURNING id, customer_id AS "customerId", cents`, [body.customerId, body.cents]);
        const reminder = await tx.crm_reminders.insert({ invoiceId: invoice!.id as number, message: body.reminder });
        return { invoice, reminder };
      });
      // Queued after the commit, so the job never runs for rows that were rolled back.
      await jobs.enqueue(sendReminder, { reminderId: reminder.id });
      status(201);
      return { invoice, reminder };
    });

  // Prisma in a job: read the invoice and its customer, then mark the reminder sent with Inferlo.
  const sendReminder = job("send-reminder", { input: t.object({ reminderId: t.uuid() }) }).handle(async ({ input, db }) => {
    const reminder = await db.crm_reminders.get(input.reminderId);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: reminder.invoiceId }, include: { customer: true } });
    // Send the email to invoice.customer here.
    await db.crm_reminders.update(reminder.id, { sentAt: new Date(), message: `${reminder.message} (${invoice.customer.name})` });
  });

  const app = createApp({
    name: "with-prisma",
    models: [Reminder],
    db: postgres({ pool }),
    routes: [{ customerTotal, getInvoice, createInvoice }],
    jobs: [{ sendReminder }],
    auth: bearer((token) => users.get(token) ?? null),
  });

  // Shut down in order: Inferlo (stops requests and jobs), then Prisma, then the pool they share.
  async function close() {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
  }
  return { app, prisma, pool, close };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof Reminder];
  }
}
