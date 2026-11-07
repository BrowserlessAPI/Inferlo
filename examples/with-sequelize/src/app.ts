// An existing Sequelize app that adopts Inferlo next to it, on the same Postgres database:
// 1. Sequelize keeps its own pool; Inferlo gets a pg pool through postgres({ pool }).
// 2. Inferlo routes read Sequelize's models, imported like any module.
// 3. A new table as an Inferlo model (with migrations from inferlo db migrate), written in the same
//    transaction as a Sequelize table through tx.$sql.
import pg from "pg";
import { Sequelize } from "sequelize";
import { bearer, createApp, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";
import { defineModels } from "./models.ts";

// A new feature, built with Inferlo: shipping labels for Sequelize's orders.
export const ShippingLabel = model("shipping_labels", {
  orderId: t.int().index(),
  carrier: t.enum(["dhl", "ups", "fedex"]),
});

export function makeApp(databaseUrl: string) {
  // Two pools on one database: keep their max sizes together under the server's max_connections.
  const sequelize = new Sequelize(databaseUrl, { dialect: "postgres", logging: false, pool: { max: 5 } });
  const { Customer, Order } = defineModels(sequelize);
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  const customerOrders = route
    .get("/customers/:id/orders", { params: t.object({ id: t.int() }) })
    .handle(async ({ params, db }) => {
      const customer = await Customer.findByPk(params.id, { include: [{ model: Order, as: "orders" }] });
      if (!customer) throw notFound(`No customer ${params.id}.`);
      const orders = (customer.get("orders") as InstanceType<typeof Order>[]).sort((a, b) => a.id - b.id);
      const ids = orders.map((o) => o.id);
      const labels = ids.length ? await db.shipping_labels.findMany({ where: { orderId: { in: ids } } }) : [];
      return {
        customer: { id: customer.id, name: customer.name },
        orders: orders.map((o) => ({ id: o.id, reference: o.reference, cents: o.cents, labels: labels.filter((l) => l.orderId === o.id).map((l) => l.carrier) })),
      };
    });

  // An order (Sequelize's table) and its shipping label (Inferlo) commit or roll back together.
  const createOrder = route
    .post("/orders", { body: t.object({ customerId: t.int(), reference: t.string().min(1).max(40), cents: t.int().min(1), carrier: t.enum(["dhl", "ups", "fedex"]) }) })
    .handle(({ body, db, status }) =>
      db.$transaction(async (tx) => {
        const [order] = await tx.$sql(
          "INSERT INTO shop_orders (customer_id, reference, cents, created_at, updated_at) VALUES ($1, $2, $3, now(), now()) RETURNING id, reference, cents",
          [body.customerId, body.reference, body.cents],
        );
        const label = await tx.shipping_labels.insert({ orderId: order!.id as number, carrier: body.carrier });
        status(201);
        return { order, label };
      }),
    );

  const app = createApp({
    name: "with-sequelize",
    models: [ShippingLabel],
    db: postgres({ pool }),
    routes: [{ customerOrders, createOrder }],
    auth: bearer((token) => users.get(token) ?? null),
  });
  return { app, sequelize, Customer, Order, pool };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof ShippingLabel];
  }
}
