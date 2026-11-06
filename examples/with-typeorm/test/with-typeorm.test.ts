import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makeApp } from "../src/app.ts";
import { AccountEntity, SubscriptionEntity } from "../src/entities.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;
const skip = !PG_URL && "set INFERLO_TEST_DATABASE_URL";
const auth = { authorization: "Bearer demo-token" };
let ctx: ReturnType<typeof makeApp>;
let accountId = 0;

before(async () => {
  if (!PG_URL) return;
  ctx = makeApp(PG_URL);
  await ctx.dataSource.initialize();
  await ctx.dataSource.query("DROP TABLE IF EXISTS saas_subscriptions, saas_accounts, renewal_notices");
  // The tables TypeORM's migrations (or synchronize) created for the existing app.
  await ctx.dataSource.synchronize();
  await ctx.app.db.$sync();
  const account = await ctx.dataSource.getRepository(AccountEntity).save({ name: "Acme" });
  accountId = account.id;
});
after(async () => {
  if (!PG_URL) return;
  await ctx.dataSource.query("DROP TABLE IF EXISTS saas_subscriptions, saas_accounts, renewal_notices");
  await ctx.app.close();
  await ctx.dataSource.destroy();
  await ctx.pool.end();
});

test("a subscription (TypeORM's table) and its notice (Inferlo) are written in one transaction", { skip }, async () => {
  const res = await ctx.app.request("/subscriptions", { method: "POST", headers: auth, json: { accountId, plan: "team", cents: 4900, notice: "Renews on the 1st" } });
  assert.equal(res.status, 201);
  const { subscription, notice } = (await res.json()) as { subscription: { id: number }; notice: { subscriptionId: number } };
  assert.equal(notice.subscriptionId, subscription.id);

  // TypeORM sees the committed row, with its relation.
  const saved = await ctx.dataSource.getRepository(SubscriptionEntity).findOne({ where: { id: subscription.id }, relations: { account: true } });
  assert.equal(saved?.account?.name, "Acme");

  const list = await ctx.app.request(`/accounts/${accountId}/subscriptions`, { headers: auth });
  assert.deepEqual(await list.json(), { account: { id: accountId, name: "Acme" }, subscriptions: [{ id: subscription.id, plan: "team", cents: 4900, notices: ["Renews on the 1st"] }] });
});

test("when the write to TypeORM's table fails, nothing is written", { skip }, async () => {
  const before = await ctx.app.db.renewal_notices.count();
  const res = await ctx.app.request("/subscriptions", { method: "POST", headers: auth, json: { accountId: 999_999, plan: "team", cents: 100, notice: "Nobody" } });
  // tx.$sql runs on Inferlo's adapter, so the foreign key error is Inferlo's 409 conflict.
  assert.equal(res.status, 409);
  assert.equal(await ctx.app.db.renewal_notices.count(), before);
  assert.equal(await ctx.dataSource.getRepository(SubscriptionEntity).count({ where: { accountId: 999_999 } }), 0);
});

test("a missing account is 404, routes stay private and validate input", { skip }, async () => {
  assert.equal((await ctx.app.request("/accounts/999999/subscriptions", { headers: auth })).status, 404);
  assert.equal((await ctx.app.request(`/accounts/${accountId}/subscriptions`)).status, 401);
  assert.equal((await ctx.app.request("/subscriptions", { method: "POST", headers: auth, json: { accountId, plan: "gold", cents: 1, notice: "x" } })).status, 422);
});

test("TypeORM's schema sync leaves Inferlo's tables alone", { skip }, async () => {
  const sql = await ctx.dataSource.driver.createSchemaBuilder().log();
  assert.deepEqual(sql.upQueries.map((q) => q.query), [], "TypeORM plans no changes with Inferlo's tables in the database");
  const columns = await ctx.app.db.$sql("select column_name from information_schema.columns where table_name = 'renewal_notices' order by column_name");
  assert.deepEqual(columns.map((c) => c.column_name), ["created_at", "id", "message", "subscription_id", "updated_at"]);
});

test("Inferlo's sync leaves TypeORM's tables alone", { skip }, async () => {
  const statements = await ctx.app.db.$sync({ dryRun: true });
  assert.ok(statements.every((s) => !s.includes('"saas_accounts"') && !s.includes('"saas_subscriptions"')), statements.join("\n"));
});
