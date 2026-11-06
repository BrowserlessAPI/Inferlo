import { route, t } from "@browserlessapi/inferlo";

export const createInvoice = route
  .post("/invoices", {
    body: t.object({ customerId: t.int(), cents: t.int().min(1), reminder: t.string().min(1).max(500) }),
    summary: "Create an invoice with its first reminder",
  })
  .handle(async ({ body, db, status }) => {
    // Prisma keeps its transactions to itself, so Prisma's table is written with parameterised SQL
    // in Inferlo's transaction, next to the Inferlo model.
    const result = await db.$transaction(async (tx) => {
      const [invoice] = await tx.$sql("INSERT INTO invoices (customer_id, cents) VALUES ($1, $2) RETURNING id", [body.customerId, body.cents]);
      const reminder = await tx.reminders.insert({ invoiceId: Number(invoice!.id), message: body.reminder });
      return { invoiceId: Number(invoice!.id), reminder };
    });
    status(201);
    return result;
  });
