import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createDb, InferloError, model, t } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";

// A pool whose every query fails with the given Postgres error, so the error mapping
// is tested on every Postgres version, not only the one installed locally.
function failingPool(error: { code: string; message: string; table?: string; constraint?: string }) {
  return {
    query: async () => {
      throw Object.assign(new Error(error.message), error);
    },
    connect: async () => {
      throw new Error("not used");
    },
    end: async () => {},
  };
}

const User = model("pe_users", { email: t.string() });

const isCode = (code: string) => (error: unknown) => error instanceof InferloError && error.code === code;

describe("Postgres error codes", () => {
  test("a foreign key violation (23503) is IL4011 with status 409", async () => {
    const db = createDb([User], postgres({ pool: failingPool({ code: "23503", message: "violates foreign key constraint", table: "pe_users", constraint: "x_fkey" }) as never }));
    await assert.rejects(db.$sql(`DELETE FROM "pe_users"`), (error: unknown) => isCode("IL4011")(error) && (error as InferloError).status === 409);
  });

  test("an ON DELETE RESTRICT violation (23001, PostgreSQL 18) is IL4011 too", async () => {
    const db = createDb([User], postgres({ pool: failingPool({ code: "23001", message: 'violates RESTRICT setting of foreign key constraint "x_fkey"', table: "pe_users", constraint: "x_fkey" }) as never }));
    await assert.rejects(db.$sql(`DELETE FROM "pe_users"`), (error: unknown) => {
      assert.ok(isCode("IL4011")(error));
      const e = error as InferloError;
      assert.equal(e.status, 409);
      assert.deepEqual(e.details, { table: "pe_users", constraint: "x_fkey" });
      assert.equal((e.cause as { code: string }).code, "23001");
      return true;
    });
  });
});
