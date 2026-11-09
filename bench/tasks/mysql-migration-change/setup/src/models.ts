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
  color: t.string().max(20).optional(),
  ownerId: t.ref("users", { onDelete: "cascade" }),
});

// inferlo:models
export const models = [User, ApiKey, Note] as const;

export type AppUser = { id: string; email: string; name: string; roles: string[] };

declare module "@browserlessapi/inferlo" {
  interface Register {
    models: typeof models;
    user: AppUser;
  }
}
