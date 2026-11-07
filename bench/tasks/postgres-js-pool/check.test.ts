import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DATABASE_URL = "postgres://bench:bench@127.0.0.1:1/bench";
const { sql } = await import("../src/db.ts");
after(() => sql.end({ timeout: 0 }));

test("Inferlo's queries and transactions run on the app's postgres.js instance", async () => {
  // Stand in for the database: record what runs on the pool and on reserved (transaction) connections.
  const log: string[] = [];
  const answer = (who: string) => async (text: string, params: unknown[] = []) => {
    const statement = text.replace(/\s+/g, " ").trim();
    log.push(`${who}: ${statement.split(" ").slice(0, 3).join(" ")}`);
    if (/^INSERT INTO "users"/i.test(statement)) {
      return Object.assign([{ id: "00000000-0000-4000-8000-000000000001", email: params[0], name: params[1], role: "member", created_at: new Date(), updated_at: new Date() }], { count: 1 });
    }
    return Object.assign([], { count: 0 });
  };
  const target = sql as unknown as Record<string, unknown>;
  target.unsafe = answer("pool");
  let reserved = 0;
  target.reserve = async () => {
    const name = `conn${++reserved}`;
    return Object.assign(() => {}, { unsafe: answer(name), release: () => log.push(`${name}: released`) });
  };

  const { app } = await import("../src/app.ts");
  const db = app.db as any;
  assert.deepEqual(await db.users.findMany({ where: { email: "ada@example.com" } }), []);
  assert.ok(log.some((l) => /^pool: SELECT \* FROM/.test(l)), `Inferlo queries go through postgres.js: ${JSON.stringify(log)}`);

  await db.$transaction(async (tx: any) => {
    await tx.users.insert({ email: "ada@example.com", name: "Ada" });
  });
  assert.deepEqual(log.filter((l) => l.startsWith("conn1")).map((l) => l.slice(7)), ["BEGIN", 'INSERT INTO "users"', "COMMIT", "released"], "transactions on a reserved postgres.js connection");
});
