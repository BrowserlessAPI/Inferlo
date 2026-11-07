// The postgres.js instance the rest of the backend uses. postgres.js connects on the first query.
import postgresJs from "postgres";

export const sql = postgresJs(process.env.DATABASE_URL ?? "postgres://localhost:5432/app", { max: 10 });
