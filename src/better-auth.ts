/**
 * Better Auth sessions as an Inferlo app's auth, without a runtime dependency on Better Auth:
 *
 *   import { betterAuth } from "better-auth";
 *   import { betterAuthSession } from "@browserlessapi/inferlo/better-auth";
 *
 *   export const auth = betterAuth({ database: pool, emailAndPassword: { enabled: true } });
 *   export const session = betterAuthSession(auth, {
 *     user: ({ user }) => ({ id: user.id, email: user.email, roles: user.role ? [user.role] : [] }),
 *   });
 *   createApp({ auth: session, middleware: [session.middleware], ... });
 *
 * session.middleware answers Better Auth's own endpoints (sign-up, sign-in, sign-out, OAuth callbacks) under its
 * basePath, "/api/auth" by default. Inferlo routes see the signed-in user from Better Auth's session cookie (or its
 * bearer plugin). Requests that change data (POST, PUT, PATCH, DELETE) with the session cookie are refused with
 * IL3007 when a browser sends them from another site, so other sites cannot act for a signed-in user.
 */
import type { AuthConfig, Middleware } from "./app.ts";
import { InferloError } from "./errors.ts";
import type { AppDb, AppUser } from "./route.ts";

/** The user Better Auth returns with a session. Plugins add fields, such as role (admin plugin). */
export interface BetterAuthUser {
  id: string;
  email: string;
  name: string;
  emailVerified?: boolean;
  image?: string | null;
  role?: string | null;
  [field: string]: unknown;
}

/** The session Better Auth returns. Plugins add fields, such as activeOrganizationId (organization plugin). */
export interface BetterAuthSessionData {
  id: string;
  userId: string;
  expiresAt: Date;
  activeOrganizationId?: string | null;
  [field: string]: unknown;
}

/** The parts of a Better Auth instance (what betterAuth({ ... }) returns) that Inferlo uses. */
export interface BetterAuthLike {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(context: { headers: Headers }): Promise<{ user: BetterAuthUser; session: BetterAuthSessionData } | null | undefined>;
  };
  options: { basePath?: string; baseURL?: unknown; trustedOrigins?: unknown; advanced?: unknown };
}

export interface BetterAuthSessionOptions {
  /**
   * The app's user for a Better Auth session, or null to refuse it (for example a disabled account). Default:
   * { id, email, name, roles }, with roles from the admin plugin's comma-separated user.role.
   */
  user?: (
    data: { user: BetterAuthUser; session: BetterAuthSessionData },
    ctx: { db: AppDb; req: Request },
  ) => AppUser | null | undefined | Promise<AppUser | null | undefined>;
  /**
   * Origins ("https://admin.example.com") whose pages may change data with the session cookie, besides the app's
   * own. Default: Better Auth's trustedOrigins when it is a list, and the origin of its baseURL.
   */
  trustedOrigins?: string[];
  /** Roles of a user, checked when a route uses auth: "<role>". Default: user.roles ?? []. */
  roles?: (user: AppUser) => string[];
  /** The tenant of a user, for tenant-scoped models. Default: user.tenantId. */
  tenant?: (user: AppUser) => string | null | undefined;
}

/** createApp({ auth: session, middleware: [session.middleware] }) for a Better Auth instance. */
export interface BetterAuthSession extends AuthConfig {
  /** Answers Better Auth's own endpoints under basePath with auth.handler; other requests go on to the app. */
  middleware: Middleware;
  /** The path Better Auth's endpoints are under, such as "/api/auth". */
  basePath: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const fix = 'Pass the instance betterAuth({ ... }) returns: betterAuthSession(auth, { user: ({ user }) => ({ id: user.id, email: user.email }) }).';

function originOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function defaultUser({ user }: { user: BetterAuthUser }): AppUser {
  const roles = typeof user.role === "string" ? user.role.split(",").map((r) => r.trim()).filter(Boolean) : [];
  // Apps that register their own user type (Register) map the session with options.user.
  return { id: user.id, email: user.email, name: user.name, roles } as AppUser;
}

/** Whether the request carries a cookie named like Better Auth's session token (its prefix is configurable). */
function hasSessionCookie(req: Request): boolean {
  const header = req.headers.get("cookie");
  return header !== null && /(?:^|;\s*)(?:__Secure-|__Host-)?[^=;]*session_token=/.test(header);
}

/**
 * Better Auth sessions as the app's auth: createApp({ auth: session, middleware: [session.middleware] }) with
 * session = betterAuthSession(auth). Routes get the user that options.user returns for the session.
 */
export function betterAuthSession(auth: BetterAuthLike, options: BetterAuthSessionOptions = {}): BetterAuthSession {
  if (!auth || typeof auth !== "object" || typeof auth.handler !== "function" || typeof auth.api?.getSession !== "function" || !auth.options || typeof auth.options !== "object") {
    throw new InferloError("IL6041", "betterAuthSession() needs a Better Auth instance.", { fix });
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new InferloError("IL6041", "betterAuthSession() options must be an object.", { fix });
  for (const key of Object.keys(options)) {
    if (!["user", "trustedOrigins", "roles", "tenant"].includes(key)) {
      throw new InferloError("IL6041", `betterAuthSession() has no option "${key}".`, { fix: "Use user, trustedOrigins, roles or tenant." });
    }
  }
  for (const key of ["user", "roles", "tenant"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") throw new InferloError("IL6041", `betterAuthSession() ${key} must be a function.`, { fix });
  }
  const basePath = auth.options.basePath === undefined ? "/api/auth" : auth.options.basePath;
  if (typeof basePath !== "string" || !basePath.startsWith("/") || !basePath.replace(/\/+$/, "")) {
    throw new InferloError("IL6041", `Better Auth's basePath must be a path such as "/api/auth", got ${JSON.stringify(basePath)}.`, { fix: 'Leave basePath out of betterAuth({ ... }) or set it to a path under the root such as "/api/auth", so the app\'s own routes stay reachable.' });
  }
  const base = basePath.replace(/\/+$/, "");

  let trusted: string[];
  if (options.trustedOrigins !== undefined) {
    if (!Array.isArray(options.trustedOrigins)) throw new InferloError("IL6041", "betterAuthSession() trustedOrigins must be a list of origins.", { fix: 'Use trustedOrigins: ["https://admin.example.com"].' });
    trusted = options.trustedOrigins.map((value) => {
      const origin = originOf(value);
      if (!origin || origin !== value.replace(/\/+$/, "")) {
        throw new InferloError("IL6041", `betterAuthSession() trustedOrigins: ${JSON.stringify(value)} is not an origin.`, { fix: 'Use origins without a path, such as "https://admin.example.com".' });
      }
      return origin;
    });
  } else {
    const fromAuth = Array.isArray(auth.options.trustedOrigins) ? auth.options.trustedOrigins : [];
    trusted = [...fromAuth, auth.options.baseURL].map(originOf).filter((o): o is string => o !== null);
  }
  const trustedSet = new Set(trusted);
  const toUser = options.user ?? defaultUser;

  /**
   * Cross-site request protection for requests that change data with the session cookie, as browsers mark them:
   * Sec-Fetch-Site (same-origin or none passes), then Origin (the app's own host or a trusted origin passes).
   * Clients that send neither header are not browsers, so no other site can make them send the cookie.
   */
  const sameSite = (req: Request, url: URL): boolean => {
    const origin = req.headers.get("origin");
    if (origin !== null && trustedSet.has(origin)) return true;
    const site = req.headers.get("sec-fetch-site");
    if (site !== null) return site === "same-origin" || site === "none";
    if (origin === null) return true;
    if (origin === "null") return false;
    try {
      return new URL(origin).host === (req.headers.get("host") ?? url.host);
    } catch {
      return false;
    }
  };

  return {
    basePath: base,
    middleware: async ({ req, url }, next) => {
      const path = url.pathname;
      if (path === base || path.startsWith(base + "/")) return auth.handler(req);
      return next();
    },
    async resolve(req, { db, url }) {
      const found = await auth.api.getSession({ headers: req.headers });
      if (!found || !found.user || !found.session) return null;
      if (!SAFE_METHODS.has(req.method.toUpperCase()) && hasSessionCookie(req) && !req.headers.has("authorization") && !sameSite(req, url)) {
        throw new InferloError("IL3007", "Requests that change data with the session cookie must come from the app's own pages.", {
          status: 403,
          fix: "Send the request from a page of the app's own origin, or add the page's origin to betterAuthSession(auth, { trustedOrigins: [...] }) (or Better Auth's trustedOrigins).",
        });
      }
      return (await toUser(found, { db, req })) ?? null;
    },
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.tenant ? { tenant: options.tenant } : {}),
  };
}
