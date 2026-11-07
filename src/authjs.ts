/**
 * Auth.js (@auth/core) sessions as an Inferlo app's auth, without a runtime dependency on Auth.js:
 *
 *   import { Auth } from "@auth/core";
 *   import GitHub from "@auth/core/providers/github";
 *   import { authJsSession } from "@browserlessapi/inferlo/authjs";
 *
 *   export const authConfig = {
 *     secret: settings.AUTH_SECRET,
 *     providers: [GitHub],
 *     callbacks: { session: ({ session, token }) => ({ ...session, user: { ...session.user, id: token.sub } }) },
 *   };
 *   export const session = authJsSession(Auth, authConfig);
 *   createApp({ auth: session, middleware: [session.middleware], ... });
 *
 * session.middleware answers Auth.js's own endpoints (sign-in, callbacks, sign-out, session, csrf) under its
 * basePath, "/auth" by default. Inferlo routes get the signed-in user from Auth.js's session cookie. Requests that
 * change data (POST, PUT, PATCH, DELETE) with the session cookie are refused with IL3007 when a browser sends them
 * from another site.
 */
import type { AuthConfig, Middleware } from "./app.ts";
import { checkCrossSite, originOf } from "./cross-site.ts";
import { InferloError } from "./errors.ts";
import type { AppDb, AppUser } from "./route.ts";

/** The session Auth.js answers at <basePath>/session. Its callbacks.session decides what is in it. */
export interface AuthJsSessionData {
  user?: { id?: string; email?: string | null; name?: string | null; image?: string | null; [field: string]: unknown };
  expires: string;
  [field: string]: unknown;
}

/** Auth.js's request handler: Auth from "@auth/core". */
export type AuthJsHandler = (request: Request, config: any) => Promise<Response>;

/** The parts of an Auth.js configuration that Inferlo reads. The whole object is passed on to Auth. */
export interface AuthJsConfigLike {
  providers: unknown[];
  basePath?: string;
  [option: string]: unknown;
}

export interface AuthJsSessionOptions {
  /**
   * The app's user for an Auth.js session, or null to refuse it. Default: { id, email, name, roles } from
   * session.user, with id from session.user.id (add it in callbacks.session) and roles from session.user.roles.
   */
  user?: (session: AuthJsSessionData, ctx: { db: AppDb; req: Request }) => AppUser | null | undefined | Promise<AppUser | null | undefined>;
  /** Origins ("https://admin.example.com") whose pages may change data with the session cookie, besides the app's own. */
  trustedOrigins?: string[];
  /** Roles of a user, checked when a route uses auth: "<role>". Default: user.roles ?? []. */
  roles?: (user: AppUser) => string[];
  /** The tenant of a user, for tenant-scoped models. Default: user.tenantId. */
  tenant?: (user: AppUser) => string | null | undefined;
}

/** createApp({ auth: session, middleware: [session.middleware] }) for Auth.js. */
export interface AuthJsSession extends AuthConfig {
  /** Answers Auth.js's own endpoints under basePath with Auth(req, config); other requests go on to the app. */
  middleware: Middleware;
  /** The path Auth.js's endpoints are under, such as "/auth". */
  basePath: string;
}

const fix = 'Pass Auth from "@auth/core" and your Auth.js configuration: authJsSession(Auth, { secret, providers: [...] }).';
const idFix = "Add the user id to the session in the Auth.js configuration: callbacks: { session: ({ session, token }) => ({ ...session, user: { ...session.user, id: token.sub } }) } (with the database strategy: ({ session, user }) => ({ ...session, user: { ...session.user, id: user.id } })), or pass authJsSession(Auth, config, { user: (session) => ... }).";

/** Whether the request carries a cookie named like Auth.js's session token (authjs or next-auth, chunked or not). */
function hasSessionCookie(req: Request): boolean {
  const header = req.headers.get("cookie");
  return header !== null && /(?:^|;\s*)[^=;]*session-token(?:\.\d+)?=/.test(header);
}

function defaultUser(session: AuthJsSessionData): AppUser {
  const user = session.user ?? {};
  if (typeof user.id !== "string" || !user.id) throw new InferloError("IL6044", "The Auth.js session has no user id.", { fix: idFix });
  const roles = Array.isArray(user.roles) ? user.roles.filter((r): r is string => typeof r === "string") : [];
  const out: Record<string, unknown> = { id: user.id, roles };
  if (typeof user.email === "string") out.email = user.email;
  if (typeof user.name === "string") out.name = user.name;
  // Apps that register their own user type (Register) map the session with options.user.
  return out as AppUser;
}

/**
 * Auth.js sessions as the app's auth: createApp({ auth: session, middleware: [session.middleware] }) with
 * session = authJsSession(Auth, config). Routes get the user that options.user returns for the session.
 */
export function authJsSession(Auth: AuthJsHandler, config: AuthJsConfigLike, options: AuthJsSessionOptions = {}): AuthJsSession {
  if (typeof Auth !== "function") throw new InferloError("IL6043", 'authJsSession() needs Auth from "@auth/core" as its first argument.', { fix });
  if (!config || typeof config !== "object" || Array.isArray(config) || !Array.isArray(config.providers)) {
    throw new InferloError("IL6043", "authJsSession() needs the Auth.js configuration, with its providers, as its second argument.", { fix });
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new InferloError("IL6043", "authJsSession() options must be an object.", { fix });
  for (const key of Object.keys(options)) {
    if (!["user", "trustedOrigins", "roles", "tenant"].includes(key)) {
      throw new InferloError("IL6043", `authJsSession() has no option "${key}".`, { fix: "Use user, trustedOrigins, roles or tenant." });
    }
  }
  for (const key of ["user", "roles", "tenant"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") throw new InferloError("IL6043", `authJsSession() ${key} must be a function.`, { fix });
  }
  const basePath = config.basePath === undefined ? "/auth" : config.basePath;
  if (typeof basePath !== "string" || !basePath.startsWith("/") || !basePath.replace(/\/+$/, "")) {
    throw new InferloError("IL6043", `Auth.js's basePath must be a path such as "/auth", got ${JSON.stringify(basePath)}.`, {
      fix: 'Leave basePath out of the Auth.js configuration or set it to a path under the root such as "/auth", so the app\'s own routes stay reachable.',
    });
  }
  const base = basePath.replace(/\/+$/, "");
  if (options.trustedOrigins !== undefined && !Array.isArray(options.trustedOrigins)) {
    throw new InferloError("IL6043", "authJsSession() trustedOrigins must be a list of origins.", { fix: 'Use trustedOrigins: ["https://admin.example.com"].' });
  }
  const trusted = new Set(
    (options.trustedOrigins ?? []).map((value) => {
      const origin = originOf(value);
      if (!origin || origin !== String(value).replace(/\/+$/, "")) {
        throw new InferloError("IL6043", `authJsSession() trustedOrigins: ${JSON.stringify(value)} is not an origin.`, { fix: 'Use origins without a path, such as "https://admin.example.com".' });
      }
      return origin;
    }),
  );
  const toUser = options.user ?? defaultUser;

  return {
    basePath: base,
    middleware: async ({ req, url }, next) => {
      const path = url.pathname;
      if (path === base || path.startsWith(base + "/")) return Auth(req, config);
      return next();
    },
    async resolve(req, { db, url }) {
      if (!hasSessionCookie(req)) return null;
      // Auth.js reads and decrypts its own cookie: ask its session endpoint, as its framework adapters do.
      const headers = new Headers();
      for (const name of ["cookie", "host", "x-forwarded-host", "x-forwarded-proto", "user-agent"]) {
        const value = req.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const response = await Auth(new Request(new URL(`${base}/session`, url), { headers }), config);
      if (response.status !== 200) {
        throw new InferloError("IL6044", `Auth.js answered ${response.status} for the session; check its configuration (secret, trustHost, basePath).`, { fix: "Fix the Auth.js configuration; its log says what is wrong." });
      }
      const session = (await response.json()) as AuthJsSessionData | null;
      if (!session || !session.user) return null;
      checkCrossSite(req, url, trusted, hasSessionCookie, "authJsSession(Auth, config, { trustedOrigins: [...] })");
      return (await toUser(session, { db, req })) ?? null;
    },
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.tenant ? { tenant: options.tenant } : {}),
  };
}
