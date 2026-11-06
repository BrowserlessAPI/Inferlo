import { model, t } from "@browserlessapi/inferlo";

export const User = model("users", {
  email: t.email().unique(),
  name: t.string().max(80),
  role: t.enum(["member", "admin"]).default("member"),
  orgId: t.string().max(100).default("personal"),
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

// Rows belong to the signed-in user's organisation (user.tenantId): ctx.db filters and stamps them.
export const Project = model("projects", { name: t.string().min(1).max(100) }, { tenant: true });

// inferlo:models
export const models = [User, ApiKey, Note, Project] as const;

export type AppUser = { id: string; email: string; name: string; roles: string[]; tenantId?: string };

declare module "@browserlessapi/inferlo" {
  interface Register {
    models: typeof models;
    user: AppUser;
  }
}
