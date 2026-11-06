// The existing Drizzle schema. drizzle-kit keeps managing these tables; Inferlo never touches them.
import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id").notNull().references(() => customers.id),
  cents: integer("cents").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
