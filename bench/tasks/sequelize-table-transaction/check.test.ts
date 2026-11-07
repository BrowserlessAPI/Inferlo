import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { postgres } from "@browserlessapi/inferlo/postgres";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as orders from "../src/routes/orders.ts";

// A stand-in for pg.Pool that records which connection ran each statement.
function fakePool(failLabel = false) {
  const log: string[] = [];
  let nextOrder = 41;
  const run = (who: string) => async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    log.push(`${who}: ${sql.split(" ").slice(0, 3).join(" ")}`);
    if (/^insert into "?shop_orders"?/i.test(sql)) {
      assert.ok(params.length >= 3 && !sql.includes(String(params[1])), "the order insert passes its values as $1 parameters");
      // created_at and updated_at are NOT NULL without a default: Sequelize sets them itself.
      if (!/created_at/i.test(sql) || !/updated_at/i.test(sql)) throw Object.assign(new Error('null value in column "created_at" violates not-null constraint'), { code: "23502" });
      return { rows: [{ id: ++nextOrder }], rowCount: 1 };
    }
    const insert = /^INSERT INTO "shipping_labels" \(([^)]*)\)/i.exec(sql);
    if (insert) {
      if (failLabel) throw Object.assign(new Error("shipping_labels is locked"), { code: "55P03" });
      const columns = insert[1]!.split(",").map((c) => c.trim().replace(/"/g, ""));
      const row: Record<string, unknown> = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
      row.id ??= "00000000-0000-4000-8000-000000000001";
      row.created_at ??= new Date();
      row.updated_at ??= new Date();
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  let conn = 0;
  return {
    log,
    query: run("pool"),
    async connect() {
      const name = `conn${++conn}`;
      return { query: run(name), release() {} };
    },
    async end() {},
  };
}

const ada = { id: "11111111-1111-4111-8111-111111111111", email: "ada@x.io", name: "Ada", roles: [] };
const order = { customerId: 3, reference: "A-1", cents: 1500, carrier: "dhl" };

test("the order and its shipping label are written in one transaction", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*orders/, "registers the orders routes");
  const pool = fakePool();
  const app = createApp({ models, routes: [orders], db: postgres({ pool }), auth: { resolve: () => null }, logger: { info() {}, error() {} } });
  const body = await readJson(await app.request("/orders", { method: "POST", json: order, as: ada }), 201);
  assert.equal(body.orderId, 42);
  assert.equal(body.label.orderId, 42);
  assert.equal(body.label.carrier, "dhl");
  assert.deepEqual(pool.log.filter((l) => l.startsWith("pool")), [], "nothing runs outside the transaction");
  const work = pool.log;
  assert.equal(work[0], "conn1: BEGIN");
  assert.ok(work.some((l) => /conn1: insert into "?shop_orders"?/i.test(l)), "the order is inserted in the transaction");
  assert.ok(work.some((l) => /conn1: INSERT INTO "shipping_labels"/i.test(l)), "the label is inserted in the transaction");
  assert.equal(work.at(-1), "conn1: COMMIT");
  await readJson(await app.request("/orders", { method: "POST", json: { ...order, carrier: "post" }, as: ada }), 422);
});

test("when the label fails, the order is rolled back", async () => {
  const pool = fakePool(true);
  const app = createApp({ models, routes: [orders], db: postgres({ pool }), auth: { resolve: () => null }, logger: { info() {}, error() {} } });
  const res = await app.request("/orders", { method: "POST", json: order, as: ada });
  assert.ok(res.status >= 400, `fails, got ${res.status}`);
  assert.equal(pool.log.at(-1), "conn1: ROLLBACK");
  assert.ok(!pool.log.includes("conn1: COMMIT"));
});
