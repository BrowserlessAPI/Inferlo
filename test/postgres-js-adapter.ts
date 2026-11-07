/**
 * Inferlo's Postgres adapter on a postgres.js pool (postgresJsPool), run by the database tests next to pg.
 * Connections close after a second idle, so the test process can exit.
 */
import postgresJs from "postgres";
import { postgres } from "../src/db/postgres.ts";
import { postgresJsPool } from "../src/postgres-js.ts";

export function postgresJsAdapter(url: string) {
  return postgres({ pool: postgresJsPool(postgresJs(url, { max: 5, idle_timeout: 1, onnotice: () => {} })) });
}
