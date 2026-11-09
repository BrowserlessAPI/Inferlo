// The MySQL adapter on a database of its own, created for each suite, so earlier runs leave nothing behind.
import { mysql } from "../src/db/mysql.ts";
import type { Adapter } from "../src/index.ts";

export const MYSQL_URL = process.env.INFERLO_TEST_MYSQL_URL;

/** A mysql() adapter on a new, empty database next to the one in INFERLO_TEST_MYSQL_URL. */
export function mysqlAdapter(): Adapter {
  const url = new URL(MYSQL_URL!);
  const name = `inferlo_t_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const adapter = mysql({ url: `${url.protocol}//${url.username}:${url.password}@${url.host}/${name}` });
  let created: Promise<void> | undefined;
  const create = () =>
    (created ??= (async () => {
      const { createConnection } = (await import("mysql2/promise")) as typeof import("mysql2/promise");
      const conn = await createConnection({ uri: MYSQL_URL! });
      await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
      await conn.end();
    })());
  const wrapped: Adapter = { ...adapter };
  for (const key of ["insert", "select", "update", "delete", "count", "search", "sync", "sql", "transaction"] as const) {
    const fn = adapter[key] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (fn) (wrapped as unknown as Record<string, unknown>)[key] = async (...args: unknown[]) => (await create(), fn.apply(adapter, args));
  }
  wrapped.close = async () => {
    await adapter.close?.();
    if (!created) return;
    const { createConnection } = (await import("mysql2/promise")) as typeof import("mysql2/promise");
    const conn = await createConnection({ uri: MYSQL_URL! });
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await conn.end();
  };
  return wrapped;
}
