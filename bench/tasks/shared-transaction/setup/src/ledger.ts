// Existing code from the part of the app that uses Drizzle on the same Postgres database.
// It writes with whatever pg client it is given: the pool, or a transaction's connection.
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

export async function recordPayment(client: PgQueryable, invoiceId: number, cents: number): Promise<void> {
  await client.query("update invoices set paid_cents = paid_cents + $2 where id = $1", [invoiceId, cents]);
}
