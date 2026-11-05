/**
 * Named permissions, checked the same way in routes, AI tools and jobs:
 *
 *   export const access = permissions({
 *     "reports.view": { roles: ["admin", "analyst"] },
 *     "tickets.update": ({ user, ticket }: { user: AppUser; ticket: Row<typeof Ticket> }) =>
 *       ticket.ownerId === user.id || (user.roles ?? []).includes("admin"),
 *   });
 *
 *   await access.can("tickets.update", { user, ticket })        // true or false
 *   await access.authorize("tickets.update", { user, ticket })  // throws IL3004 (403) when not allowed
 *   route.get("/reports", { permission: "reports.view" })       // checked before the handler runs
 *
 * Deny by default: a missing user, an unknown permission or a rule that does not return true never allows.
 */
import { InferloError } from "./errors.ts";
import type { AppUser } from "./route.ts";

/** A rule: a function of the user (and the resources it needs) that returns true to allow, or the roles that may. */
export type PermissionRule = ((input: any) => boolean | Promise<boolean>) | { readonly roles: readonly string[] };

/** What can() and authorize() take for a rule: the function's input, or { user } for a roles rule. */
export type PermissionInput<R> = R extends (input: infer I) => unknown ? I : { user: AppUser | null | undefined };

export interface Permissions<Rules extends Record<string, PermissionRule> = Record<string, PermissionRule>> {
  readonly kind: "inferlo.permissions";
  /** Every permission with its roles, for roles rules (shown in describe). */
  readonly list: readonly { readonly name: string; readonly roles?: readonly string[] }[];
  /** True when the rule allows it. Never throws for a denial; a missing user is always denied. */
  can<K extends keyof Rules & string>(name: K, input: PermissionInput<Rules[K]>): Promise<boolean>;
  /** Resolves when the rule allows it; throws IL3001 (401) without a user and IL3004 (403) otherwise. */
  authorize<K extends keyof Rules & string>(name: K, input: PermissionInput<Rules[K]>): Promise<void>;
  /** True when the permission exists. */
  has(name: string): boolean;
}

const fix = 'Define each permission as a function that returns true or false, or as { roles: ["admin"] }: permissions({ "tickets.update": ({ user, ticket }) => ticket.ownerId === user.id }).';

function invalid(message: string): InferloError {
  return new InferloError("IL6026", message, { fix });
}

/** Define the app's permissions by name. Pass the result to createApp({ permissions }) to use route permission options. */
export function permissions<const Rules extends Record<string, PermissionRule>>(rules: Rules): Permissions<Rules> {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) throw invalid("permissions() takes an object of named rules.");
  const table = new Map<string, PermissionRule>();
  const list: { name: string; roles?: readonly string[] }[] = [];
  for (const [name, rule] of Object.entries(rules)) {
    if (!/^[A-Za-z][\w-]*(\.[\w-]+)*$/.test(name)) throw invalid(`Invalid permission name "${name}". Use names like "tickets.update".`);
    if (typeof rule === "function") {
      table.set(name, rule);
      list.push({ name });
      continue;
    }
    const roles = (rule as { roles?: unknown } | null)?.roles;
    const keys = rule && typeof rule === "object" ? Object.keys(rule) : [];
    if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => typeof r !== "string" || r === "") || keys.some((k) => k !== "roles")) {
      throw invalid(`Invalid rule for permission "${name}".`);
    }
    const frozen = Object.freeze([...roles] as string[]);
    table.set(name, { roles: frozen });
    list.push(Object.freeze({ name, roles: frozen }));
  }

  const check = async (name: string, input: unknown): Promise<boolean> => {
    const rule = table.get(name);
    if (!rule) throw invalid(`Unknown permission "${name}". Defined: ${[...table.keys()].join(", ") || "none"}.`);
    const user = (input as { user?: AppUser | null } | null | undefined)?.user;
    if (!user) return false;
    if (typeof rule !== "function") {
      const roles = (user as { roles?: unknown }).roles;
      return Array.isArray(roles) && rule.roles.some((role) => roles.includes(role));
    }
    const allowed = await rule(input);
    if (typeof allowed !== "boolean") throw invalid(`The rule for permission "${name}" returned ${allowed === undefined ? "undefined" : typeof allowed} instead of true or false.`);
    return allowed;
  };

  return Object.freeze({
    kind: "inferlo.permissions" as const,
    list: Object.freeze(list),
    can: (name: string, input: unknown) => check(name, input),
    async authorize(name: string, input: unknown) {
      if (await check(name, input)) return;
      if (!(input as { user?: unknown } | null | undefined)?.user) {
        throw new InferloError("IL3001", "Sign in required.", { status: 401, fix: "Send valid credentials, e.g. an Authorization: Bearer <token> header." });
      }
      throw new InferloError("IL3004", `You do not have the "${name}" permission.`, { status: 403, fix: "Sign in as a user the permission allows, or ask an administrator for access." });
    },
    has: (name: string) => table.has(name),
  }) as Permissions<Rules>;
}

export function isPermissions(value: unknown): value is Permissions {
  return typeof value === "object" && value !== null && (value as Permissions).kind === "inferlo.permissions";
}
