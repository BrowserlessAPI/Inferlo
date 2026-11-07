import { route, t } from "@browserlessapi/inferlo";

export const createOrder = route
  .post("/orders", {
    body: t.object({ customerId: t.int(), reference: t.string().min(1).max(40), cents: t.int().min(1), carrier: t.enum(["dhl", "ups", "fedex"]) }),
    summary: "Create an order with its shipping label",
  })
  .handle(async ({ body, db, status }) => {
    // Sequelize keeps its transactions to itself, so its table is written with parameterised SQL in Inferlo's
    // transaction, next to the Inferlo model, with the timestamps Sequelize would set.
    const result = await db.$transaction(async (tx) => {
      const [order] = await tx.$sql(
        "INSERT INTO shop_orders (customer_id, reference, cents, created_at, updated_at) VALUES ($1, $2, $3, now(), now()) RETURNING id",
        [body.customerId, body.reference, body.cents],
      );
      const label = await tx.shipping_labels.insert({ orderId: Number(order!.id), carrier: body.carrier });
      return { orderId: Number(order!.id), label };
    });
    status(201);
    return result;
  });
