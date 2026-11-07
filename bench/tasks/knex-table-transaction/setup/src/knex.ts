// The Knex instance the older part of the app uses for its tables (crm_companies, crm_contacts).
import knexFactory from "knex";

export const knex = knexFactory({ client: "pg", connection: process.env.DATABASE_URL ?? "postgres://localhost:5432/app", pool: { min: 0, max: 5 } });
