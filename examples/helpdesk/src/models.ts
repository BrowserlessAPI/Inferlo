import { model, t } from "../../../src/index.ts";

export const User = model("users", {
  email: t.email().unique(),
  name: t.string().max(80),
  role: t.enum(["member", "agent"]).default("member"),
});

export const Ticket = model("tickets", {
  title: t.string().min(3).max(200).describe("Short summary of the problem"),
  body: t.text().describe("Full description from the customer"),
  priority: t.enum(["low", "normal", "urgent"]).default("normal"),
  status: t.enum(["open", "closed"]).default("open").index(),
  ownerId: t.ref("users", { onDelete: "cascade" }),
  summary: t.string().max(500).optional(),
});

export const models = [User, Ticket] as const;

export type AppUser = { id: string; name: string; roles: string[] };

declare module "../../../src/index.ts" {
  interface Register {
    models: typeof models;
    user: AppUser;
  }
}
