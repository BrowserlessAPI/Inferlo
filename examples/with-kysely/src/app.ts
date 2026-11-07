// An existing Kysely app that adopts Inferlo next to it, on the same Postgres database:
// 1. One pg pool for both: Kysely's PostgresDialect and Inferlo's postgres({ pool }).
// 2. Inferlo routes read and write Kysely's tables with the Kysely instance, imported like any module.
// 3. A new table as an Inferlo model (with migrations from inferlo db migrate), written in the same
//    transaction as a Kysely table: Kysely runs on the transaction's connection from tx.$pgClient().
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { bearer, createApp, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";
import type { Database } from "./database.ts";

// A new feature, built with Inferlo: tracking events for Kysely's shipments.
export const TrackingEvent = model("tracking_events", {
  shipmentId: t.int().index(),
  status: t.enum(["created", "picked", "shipped", "delivered"]),
  note: t.string().max(500).optional(),
});

/** Kysely on one connection, such as the connection of an Inferlo transaction. Kysely never releases it. */
export function kyselyOn(client: pg.PoolClient): Kysely<Database> {
  const connection = { query: client.query.bind(client) as pg.PoolClient["query"], release() {} };
  // A pool of that one connection. Kysely 0.29 also reads the pool's options (for cancelling queries).
  const pool = { connect: async () => connection, end: async () => {}, options: {} };
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function makeApp(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  const warehouseShipments = route
    .get("/warehouses/:id/shipments", { params: t.object({ id: t.int() }) })
    .handle(async ({ params, db }) => {
      const warehouse = await kysely.selectFrom("warehouses").select(["id", "name"]).where("id", "=", params.id).executeTakeFirst();
      if (!warehouse) throw notFound(`No warehouse ${params.id}.`);
      const shipments = await kysely.selectFrom("shipments").select(["id", "reference"]).where("warehouse_id", "=", params.id).orderBy("id").execute();
      const ids = shipments.map((s) => s.id);
      const events = ids.length ? await db.tracking_events.findMany({ where: { shipmentId: { in: ids } }, orderBy: { createdAt: "asc" } }) : [];
      return { warehouse, shipments: shipments.map((s) => ({ ...s, statuses: events.filter((e) => e.shipmentId === s.id).map((e) => e.status) })) };
    });

  // A shipment (Kysely) and its first tracking event (Inferlo) commit or roll back together.
  const createShipment = route
    .post("/shipments", { body: t.object({ warehouseId: t.int(), reference: t.string().min(1).max(40), note: t.string().max(500).optional() }) })
    .handle(({ body, db, status }) =>
      db.$transaction(async (tx) => {
        const txKysely = kyselyOn(await tx.$pgClient<pg.PoolClient>());
        const shipment = await txKysely
          .insertInto("shipments")
          .values({ warehouse_id: body.warehouseId, reference: body.reference })
          .returning(["id", "reference"])
          .executeTakeFirstOrThrow();
        const event = await tx.tracking_events.insert({ shipmentId: shipment.id, status: "created", note: body.note });
        status(201);
        return { shipment, event };
      }),
    );

  const app = createApp({
    name: "with-kysely",
    models: [TrackingEvent],
    db: postgres({ pool }),
    routes: [{ warehouseShipments, createShipment }],
    auth: bearer((token) => users.get(token) ?? null),
  });
  return { app, kysely, pool };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof TrackingEvent];
  }
}
