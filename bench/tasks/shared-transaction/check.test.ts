import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { postgres } from "@browserlessapi/inferlo/postgres";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as payments from "../src/routes/payments.ts";

// A stand-in for pg.Pool that records which connection ran each statement.
function fakePool(failLedger = false) {
  const log: string[] = [];
  let next = 1;
  const run = (who: string) => async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    log.push(`${who}: ${sql.split(" ").slice(0, 3).join(" ")}`);
    if (/^update invoices/i.test(sql)) {
      if (failLedger) throw Object.assign(new Error("ledger is locked"), { code: "55P03" });
      return { rows: [], rowCount: 1 };
    }
    const insert = /^INSERT INTO "receipts" \(([^)]*)\)/i.exec(sql);
    if (insert) {
      const columns = insert[1]!.split(",").map((c) => c.trim().replace(/"/g, ""));
      const row: Record<string, unknown> = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
      row.id ??= `00000000-0000-4000-8000-00000000000${next++}`;
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

test("the receipt and the ledger update share one transaction", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*payments/, "registers the payments routes");
  const pool = fakePool();
  const app = createApp({ models, routes: [payments], db: postgres({ pool }), auth: { resolve: () => null } });
  const receipt = await readJson(await app.request("/invoices/7/pay", { method: "POST", json: { cents: 1500 }, as: ada }), 201);
  assert.equal(receipt.invoiceId, 7);
  assert.equal(receipt.cents, 1500);
  const work = pool.log.filter((l) => !l.startsWith("pool"));
  assert.deepEqual(pool.log.filter((l) => l.startsWith("pool")), [], "nothing runs outside the transaction");
  assert.equal(work[0], "conn1: BEGIN");
  assert.ok(work.some((l) => /conn1: INSERT INTO "receipts"/i.test(l)), "the receipt is inserted in the transaction");
  assert.ok(work.some((l) => /conn1: update invoices/i.test(l)), "recordPayment runs on the transaction's connection");
  assert.equal(work.at(-1), "conn1: COMMIT");
  await readJson(await app.request("/invoices/7/pay", { method: "POST", json: { cents: 0 }, as: ada }), 422);
});

test("when recordPayment fails, the receipt is rolled back", async () => {
  const pool = fakePool(true);
  const app = createApp({ models, routes: [payments], db: postgres({ pool }), auth: { resolve: () => null }, logger: { info() {}, error() {} } });
  const res = await app.request("/invoices/7/pay", { method: "POST", json: { cents: 100 }, as: ada });
  assert.ok(res.status >= 400, `fails, got ${res.status}`);
  assert.equal(pool.log.at(-1), "conn1: ROLLBACK");
  assert.ok(!pool.log.includes("conn1: COMMIT"));
});
