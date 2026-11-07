import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createApp } from "@browserlessapi/inferlo";
import { postgres } from "@browserlessapi/inferlo/postgres";
import { readJson } from "@browserlessapi/inferlo/testing";
import { knex } from "../src/knex.ts";
import { models } from "../src/models.ts";
import * as contacts from "../src/routes/contacts.ts";

after(() => knex.destroy());

// A stand-in for pg.Pool that records which connection ran each statement (promise and callback style, as Knex uses).
function fakePool(failNote = false) {
  const log: string[] = [];
  let nextContact = 41;
  const answer = (who: string, text: string, params: unknown[]) => {
    const sql = text.replace(/\s+/g, " ").trim();
    log.push(`${who}: ${sql.split(" ").slice(0, 3).join(" ")}`);
    if (/^insert into "?crm_contacts"?/i.test(sql)) {
      assert.ok(params.length >= 2 && !sql.includes(String(params[1])), "the contact insert passes its values as $1 parameters");
      return { rows: [{ id: ++nextContact }], rowCount: 1, command: "INSERT", fields: [] };
    }
    const insert = /^INSERT INTO "contact_notes" \(([^)]*)\)/i.exec(sql);
    if (insert) {
      if (failNote) throw Object.assign(new Error("contact_notes is locked"), { code: "55P03" });
      const columns = insert[1]!.split(",").map((c) => c.trim().replace(/"/g, ""));
      const row: Record<string, unknown> = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
      row.id ??= "00000000-0000-4000-8000-000000000001";
      row.created_at ??= new Date();
      row.updated_at ??= new Date();
      return { rows: [row], rowCount: 1, command: "INSERT", fields: [] };
    }
    return { rows: [], rowCount: 0, command: "SELECT", fields: [] };
  };
  const run = (who: string) => (config: string | { text: string; values?: unknown[] }, paramsOrCb?: unknown, cb?: (e: unknown, r?: unknown) => void): any => {
    const text = typeof config === "string" ? config : config.text;
    const params = (typeof config === "string" ? (Array.isArray(paramsOrCb) ? paramsOrCb : []) : (config.values ?? [])) as unknown[];
    const callback = typeof paramsOrCb === "function" ? (paramsOrCb as typeof cb) : cb;
    try {
      const result = answer(who, text, params);
      if (callback) return void callback(null, result);
      return Promise.resolve(result);
    } catch (error) {
      if (callback) return void callback(error);
      return Promise.reject(error);
    }
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
const quiet = { info() {}, error() {} };

test("the contact and its note are written in one transaction", async () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*contacts/, "registers the contacts routes");
  const pool = fakePool();
  const app = createApp({ models, routes: [contacts], db: postgres({ pool }), auth: { resolve: () => null }, logger: quiet });
  const body = await readJson(await app.request("/contacts", { method: "POST", json: { companyId: 3, email: "bob@acme.test", note: "Met at the fair" }, as: ada }), 201);
  assert.equal(body.contactId, 42);
  assert.equal(body.note.contactId, 42);
  assert.equal(body.note.body, "Met at the fair");
  assert.deepEqual(pool.log.filter((l) => l.startsWith("pool")), [], "nothing runs outside the transaction");
  assert.equal(pool.log[0], "conn1: BEGIN");
  assert.ok(pool.log.some((l) => /conn1: insert into "?crm_contacts"?/i.test(l)), "the contact is inserted in the transaction");
  assert.ok(pool.log.some((l) => /conn1: INSERT INTO "contact_notes"/i.test(l)), "the note is inserted in the transaction");
  assert.equal(pool.log.at(-1), "conn1: COMMIT");
  await readJson(await app.request("/contacts", { method: "POST", json: { companyId: 3, email: "nope", note: "x" }, as: ada }), 422);
  const source = readFileSync(new URL("../src/routes/contacts.ts", import.meta.url), "utf8");
  assert.match(source, /knex/, "writes crm_contacts with Knex");
});

test("when the note fails, the contact is rolled back", async () => {
  const pool = fakePool(true);
  const app = createApp({ models, routes: [contacts], db: postgres({ pool }), auth: { resolve: () => null }, logger: quiet });
  const res = await app.request("/contacts", { method: "POST", json: { companyId: 3, email: "cy@acme.test", note: "x" }, as: ada });
  assert.ok(res.status >= 400, `fails, got ${res.status}`);
  assert.equal(pool.log.at(-1), "conn1: ROLLBACK");
  assert.ok(!pool.log.includes("conn1: COMMIT"));
});
