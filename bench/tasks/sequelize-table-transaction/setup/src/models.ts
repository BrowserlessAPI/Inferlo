import { model, t } from "@browserlessapi/inferlo";

export const User = model("users", {
  email: t.email().unique(),
  name: t.string().max(80),
  role: t.enum(["member", "admin"]).default("member"),
});

export const ApiKey = model("api_keys", {
  userId: t.ref("users", { onDelete: "cascade" }),
  hash: t.string().max(64).unique(),
  label: t.string().max(80).default("default"),
});

export const Note = model("notes", {
  title: t.string().min(1).max(200),
  body: t.text().default(""),
  ownerId: t.ref("users", { onDelete: "cascade" }),
});

// A shipping label for one of the orders the Sequelize part of the app owns (Sequelize's model Order, table
// "shop_orders" with underscored: true: id serial, customer_id integer, reference varchar(40) unique,
// cents integer, created_at and updated_at timestamptz not null).
export const ShippingLabel = model("shipping_labels", { orderId: t.int().index(), carrier: t.enum(["dhl", "ups", "fedex"]) });

// inferlo:models
export const models = [User, ApiKey, Note, ShippingLabel] as const;

export type AppUser = { id: string; email: string; name: string; roles: string[] };

declare module "@browserlessapi/inferlo" {
  interface Register {
    models: typeof models;
    user: AppUser;
  }
}
