import { route, t } from "@browserlessapi/inferlo";
import { recordPayment } from "../ledger.ts";

export const payInvoice = route
  .post("/invoices/:id/pay", { params: t.object({ id: t.int() }), body: t.object({ cents: t.int().min(1) }), summary: "Pay an invoice" })
  .handle(({ params, body, db, status }) =>
    db.$transaction(async (tx) => {
      const receipt = await tx.receipts.insert({ invoiceId: params.id, cents: body.cents });
      await recordPayment(await tx.$pgClient(), params.id, body.cents);
      status(201);
      return receipt;
    }),
  );
