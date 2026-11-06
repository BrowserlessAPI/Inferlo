import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { postgres } from "@browserlessapi/inferlo/postgres";
import { readJson } from "@browserlessapi/inferlo/testing";
import { models } from "../src/models.ts";
import * as invoices from "../src/routes/invoices.ts";

// A stand-in for pg.Pool that records which connection ran each statement.
function fakePool(failReminder = false) {
  const log: string[] = [];
  let nextInvoice = 41;
  const run = (who: string) => async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    log.push(`${who}: ${sql.split(" ").slice(0, 3).join(" ")}`);
    if (/^insert into "?invoices"?/i.test(sql)) {
      assert.ok(params.length >= 2 && !sql.includes(String(params[1])), "the invoice insert passes its values as $1 parameters");
      return { rows: [{ id: ++nextInvoice, customer_id: params[0], cents: params[1] }], rowCount: 1 };
    }
    const insert = /^INSERT INTO "reminders" \(([^)]*)\)/i.exec(sql);
    if (insert) {
      if (failReminder) throw Object.assign(new Error("reminders is locked"), { code: "55P03" });
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

test("the invoice and its reminder are written in one transaction", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*invoices/, "registers the invoices routes");
  const pool = fakePool();
  const app = createApp({ models, routes: [invoices], db: postgres({ pool }), auth: { resolve: () => null } });
  const body = await readJson(await app.request("/invoices", { method: "POST", json: { customerId: 3, cents: 1500, reminder: "Due in 30 days" }, as: ada }), 201);
  assert.equal(body.invoiceId, 42);
  assert.equal(body.reminder.invoiceId, 42);
  assert.equal(body.reminder.message, "Due in 30 days");
  assert.deepEqual(pool.log.filter((l) => l.startsWith("pool")), [], "nothing runs outside the transaction");
  const work = pool.log;
  assert.equal(work[0], "conn1: BEGIN");
  assert.ok(work.some((l) => /conn1: insert into "?invoices"?/i.test(l)), "the invoice is inserted in the transaction");
  assert.ok(work.some((l) => /conn1: INSERT INTO "reminders"/i.test(l)), "the reminder is inserted in the transaction");
  assert.equal(work.at(-1), "conn1: COMMIT");
  await readJson(await app.request("/invoices", { method: "POST", json: { customerId: 3, cents: 0, reminder: "x" }, as: ada }), 422);
});

test("when the reminder fails, the invoice is rolled back", async () => {
  const pool = fakePool(true);
  const app = createApp({ models, routes: [invoices], db: postgres({ pool }), auth: { resolve: () => null }, logger: { info() {}, error() {} } });
  const res = await app.request("/invoices", { method: "POST", json: { customerId: 3, cents: 100, reminder: "x" }, as: ada });
  assert.ok(res.status >= 400, `fails, got ${res.status}`);
  assert.equal(pool.log.at(-1), "conn1: ROLLBACK");
  assert.ok(!pool.log.includes("conn1: COMMIT"));
});
