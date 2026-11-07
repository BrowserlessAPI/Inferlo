/**
 * Passport.js users as an Inferlo app's auth, for an Inferlo app mounted in Express (or node:http) with
 * toNodeHandler, without a runtime dependency on Passport:
 *
 *   import session from "express-session";
 *   import passport from "passport";
 *   import { createApp, toNodeHandler } from "@browserlessapi/inferlo";
 *   import { passportSession } from "@browserlessapi/inferlo/passport";
 *
 *   const app = createApp({ routes, auth: passportSession() });
 *   server.use(session({ secret, resave: false, saveUninitialized: false }));
 *   server.use(passport.session());                       // Passport puts the signed-in user on req.user
 *   server.use("/api", toNodeHandler(app));                // Inferlo routes get that user as ctx.user
 *
 * Inferlo reads req.user from the Node.js request the Web Request was built from; Passport's strategies,
 * serializeUser and deserializeUser stay as they are. Requests that change data (POST, PUT, PATCH, DELETE) with a
 * Passport session from express-session are refused with IL3007 when a browser sends them from another site.
 */
import type { AuthConfig } from "./app.ts";
import { nodeRequests } from "./client-ip.ts";
import { checkCrossSite, originOf } from "./cross-site.ts";
import { InferloError } from "./errors.ts";
import type { AppDb, AppUser } from "./route.ts";

/** The parts of a Node.js request that Passport and express-session set and Inferlo reads. */
export interface PassportRequestLike {
  /** The user Passport's deserializeUser (or a strategy with session: false) put on the request. */
  user?: unknown;
  /** express-session's session; Passport keeps its login in session.passport.user. */
  session?: { passport?: { user?: unknown } } | null;
}

export interface PassportSessionOptions<PassportUser = any> {
  /**
   * The app's user for Passport's req.user, or null to refuse it. Default: { id, email, name, roles } with id from
   * user.id (a string, or a number turned into a string), name from user.name or user.displayName, and roles from
   * user.roles.
   */
  user?: (user: PassportUser, ctx: { db: AppDb; req: Request; nodeRequest: PassportRequestLike }) => AppUser | null | undefined | Promise<AppUser | null | undefined>;
  /** Origins ("https://admin.example.com") whose pages may change data with the session cookie, besides the app's own. */
  trustedOrigins?: string[];
  /** Roles of a user, checked when a route uses auth: "<role>". Default: user.roles ?? []. */
  roles?: (user: AppUser) => string[];
  /** The tenant of a user, for tenant-scoped models. Default: user.tenantId. */
  tenant?: (user: AppUser) => string | null | undefined;
}

const fix = "Use passportSession({ user, trustedOrigins, roles, tenant }) and mount the app in Express after passport.session(): server.use(\"/api\", toNodeHandler(app)).";
const idFix = "Give Passport's user an id (deserializeUser should return the user with its id), or map it yourself: passportSession({ user: (u) => ({ id: String(u.userId), roles: u.roles }) }).";
const mountFix =
  'Mount the app in Express after Passport: server.use(session({ ... })); server.use(passport.session()); server.use("/api", toNodeHandler(app)). app.listen() and app.fetch() have no Express request, so Passport never runs for them.';

function defaultUser(user: unknown): AppUser {
  const u = (user && typeof user === "object" ? user : {}) as Record<string, unknown>;
  const id = typeof u.id === "number" && Number.isFinite(u.id) ? String(u.id) : u.id;
  if (typeof id !== "string" || !id) throw new InferloError("IL6046", "Passport's user (req.user) has no id.", { fix: idFix });
  const roles = Array.isArray(u.roles) ? u.roles.filter((r): r is string => typeof r === "string") : [];
  const out: Record<string, unknown> = { id, roles };
  if (typeof u.email === "string") out.email = u.email;
  const name = typeof u.name === "string" ? u.name : typeof u.displayName === "string" ? u.displayName : undefined;
  if (name !== undefined) out.name = name;
  // Apps that register their own user type (Register) map Passport's user with options.user.
  return out as AppUser;
}

/**
 * Passport's req.user as the app's auth: createApp({ auth: passportSession() }), with the app mounted in Express
 * after passport.session() through toNodeHandler. Routes get the user that options.user returns for req.user.
 */
export function passportSession<PassportUser = any>(options: PassportSessionOptions<PassportUser> = {}): AuthConfig {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new InferloError("IL6045", "passportSession() options must be an object.", { fix });
  for (const key of Object.keys(options)) {
    if (!["user", "trustedOrigins", "roles", "tenant"].includes(key)) {
      throw new InferloError("IL6045", `passportSession() has no option "${key}".`, { fix: "Use user, trustedOrigins, roles or tenant." });
    }
  }
  for (const key of ["user", "roles", "tenant"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") throw new InferloError("IL6045", `passportSession() ${key} must be a function.`, { fix });
  }
  if (options.trustedOrigins !== undefined && !Array.isArray(options.trustedOrigins)) {
    throw new InferloError("IL6045", "passportSession() trustedOrigins must be a list of origins.", { fix: 'Use trustedOrigins: ["https://admin.example.com"].' });
  }
  const trusted = new Set(
    (options.trustedOrigins ?? []).map((value) => {
      const origin = originOf(value);
      if (!origin || origin !== String(value).replace(/\/+$/, "")) {
        throw new InferloError("IL6045", `passportSession() trustedOrigins: ${JSON.stringify(value)} is not an origin.`, { fix: 'Use origins without a path, such as "https://admin.example.com".' });
      }
      return origin;
    }),
  );
  const toUser = options.user;

  return {
    async resolve(req, { db, url }) {
      const nodeRequest = nodeRequests.get(req) as PassportRequestLike | undefined;
      if (!nodeRequest) throw new InferloError("IL6046", "passportSession() needs the app mounted in Express (or node:http) with toNodeHandler.", { fix: mountFix });
      const passportUser = nodeRequest.user;
      if (passportUser === undefined || passportUser === null || passportUser === false) return null;
      // A login kept in express-session rides on a cookie the browser sends by itself: refuse it from other sites.
      const fromSession = nodeRequest.session?.passport?.user !== undefined;
      checkCrossSite(req, url, trusted, () => fromSession, "passportSession({ trustedOrigins: [...] })");
      if (toUser) return (await toUser(passportUser as PassportUser, { db, req, nodeRequest })) ?? null;
      return defaultUser(passportUser);
    },
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.tenant ? { tenant: options.tenant } : {}),
  };
}
