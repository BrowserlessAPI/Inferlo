// An existing TypeORM app that adopts Inferlo next to it, on the same Postgres database:
// 1. TypeORM keeps its DataSource and pool; Inferlo gets its own pg pool through postgres({ pool }).
// 2. Inferlo routes read TypeORM's entities with the DataSource, imported like any module.
// 3. A new table as an Inferlo model (with migrations from inferlo db migrate), written in the same
//    transaction as a TypeORM table through tx.$sql.
import pg from "pg";
import { DataSource } from "typeorm";
import { bearer, createApp, model, notFound, route, t } from "../../../src/index.ts";
import { postgres } from "../../../src/db/postgres.ts";
import { AccountEntity, SubscriptionEntity } from "./entities.ts";

// A new feature, built with Inferlo: renewal notices for TypeORM's subscriptions.
export const RenewalNotice = model("renewal_notices", {
  subscriptionId: t.int().index(),
  message: t.string().min(1).max(500),
});

export function makeApp(databaseUrl: string) {
  // Two pools on one database: keep their max sizes together under the server's max_connections.
  const dataSource = new DataSource({ type: "postgres", url: databaseUrl, entities: [AccountEntity, SubscriptionEntity], extra: { max: 5 } });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });

  const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

  const accountSubscriptions = route
    .get("/accounts/:id/subscriptions", { params: t.object({ id: t.int() }) })
    .handle(async ({ params, db }) => {
      const account = await dataSource.getRepository(AccountEntity).findOne({ where: { id: params.id }, relations: { subscriptions: true } });
      if (!account) throw notFound(`No account ${params.id}.`);
      const ids = account.subscriptions!.map((s) => s.id);
      const notices = ids.length ? await db.renewal_notices.findMany({ where: { subscriptionId: { in: ids } } }) : [];
      return {
        account: { id: account.id, name: account.name },
        subscriptions: account.subscriptions!.map((s) => ({ id: s.id, plan: s.plan, cents: s.cents, notices: notices.filter((n) => n.subscriptionId === s.id).map((n) => n.message) })),
      };
    });

  // A subscription (TypeORM's table) and its first renewal notice (Inferlo) commit or roll back together.
  const createSubscription = route
    .post("/subscriptions", { body: t.object({ accountId: t.int(), plan: t.enum(["team", "business"]), cents: t.int().min(1), notice: t.string().min(1).max(500) }) })
    .handle(({ body, db, status }) =>
      db.$transaction(async (tx) => {
        const [subscription] = await tx.$sql(
          "INSERT INTO saas_subscriptions (account_id, plan, cents) VALUES ($1, $2, $3) RETURNING id, plan, cents",
          [body.accountId, body.plan, body.cents],
        );
        const notice = await tx.renewal_notices.insert({ subscriptionId: subscription!.id as number, message: body.notice });
        status(201);
        return { subscription, notice };
      }),
    );

  const app = createApp({
    name: "with-typeorm",
    models: [RenewalNotice],
    db: postgres({ pool }),
    routes: [{ accountSubscriptions, createSubscription }],
    auth: bearer((token) => users.get(token) ?? null),
  });
  return { app, dataSource, pool };
}

declare module "../../../src/index.ts" {
  interface Register {
    models: [typeof RenewalNotice];
  }
}
