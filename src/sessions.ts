/**
 * Cookie sessions for browser apps: signed, HttpOnly cookies and CSRF protection, with no session table.
 *
 *   export const session = sessions({
 *     secret: config.SESSION_SECRET,
 *     user: ({ userId }, { db }) => db.users.find(userId),
 *   });
 *   createApp({ auth: session, ... });
 *
 *   // in a login route (auth: "public"), after checking the password:
 *   const { csrfToken } = await session.signIn(ctx, user.id);
 *   // in a logout route:
 *   session.signOut(ctx);
 *
 * Requests that change data (POST, PUT, PATCH, DELETE) with a session cookie must send the CSRF token in an
 * X-CSRF-Token header or a _csrf form field, or they are rejected with IL3005.
 */
import type { AuthConfig } from "./app.ts";
import { safeEqual } from "./auth.ts";
import { InferloError } from "./errors.ts";
import type { AppDb, AppUser } from "./route.ts";

export interface SessionData {
  /** The id passed to session.signIn(ctx, userId). */
  userId: string;
  /** When the session was created (milliseconds since 1970). Compare it to a "signed out everywhere" time to revoke older sessions. */
  issuedAt: number;
}

export interface SessionCookieOptions {
  /** Cookie name. Default "inferlo_session"; the CSRF cookie is the same name with "_csrf" added. */
  name?: string;
  /** SameSite attribute. Default "lax" (links from other sites keep the session, cross-site form posts do not send it). */
  sameSite?: "lax" | "strict";
  /** Secure attribute. Default true, except for plain http on localhost, 127.0.0.1 and ::1 during development. */
  secure?: boolean;
  /** Domain attribute, to share the session with subdomains. Default: none (only the host that set it). */
  domain?: string;
  /** Path attribute. Default "/". */
  path?: string;
}

export interface SessionsOptions {
  /**
   * The signing secret, at least 32 characters: keep it in config({ secrets }). To rotate it, pass
   * [newSecret, oldSecret]: new sessions are signed with the first, and sessions signed with any of them stay valid.
   */
  secret: string | readonly string[];
  /** Load the signed-in user for a session, or return null to end it (deleted or disabled users, revoked sessions). */
  user: (session: SessionData, ctx: { db: AppDb; req: Request }) => AppUser | null | undefined | Promise<AppUser | null | undefined>;
  /** How long a session lasts after sign-in, in milliseconds. Default 7 days; 1 minute to 400 days. */
  maxAgeMs?: number;
  cookie?: SessionCookieOptions;
  /** Roles of a user, checked when a route uses auth: "<role>". Default: user.roles ?? []. */
  roles?: (user: AppUser) => string[];
  /** The tenant of a user, for tenant-scoped models. Default: user.tenantId. */
  tenant?: (user: AppUser) => string | null | undefined;
}

/** What session.signIn and session.signOut need from the route context. */
export interface SessionResponseContext {
  url: URL;
  header(name: string, value: string): void;
}

/** createApp({ auth: session }) with sign-in, sign-out and the CSRF token of the current session. */
export interface Sessions extends AuthConfig {
  /** Start a session for this user: sets the session and CSRF cookies. Returns the CSRF token to send with changes. */
  signIn(ctx: SessionResponseContext, userId: string): Promise<{ csrfToken: string }>;
  /** End the session: clears both cookies. */
  signOut(ctx: SessionResponseContext): void;
  /** The CSRF token of the request's session (to put in a form's _csrf field), or null without a valid session. */
  csrfToken(req: Request): Promise<string | null>;
}

const DAY = 86_400_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_FORM_BYTES = 64 * 1024;
const fix = 'Pass sessions({ secret: config.SESSION_SECRET, user: ({ userId }, { db }) => db.users.find(userId) }) with a secret of at least 32 random characters (openssl rand -base64 32).';

/** Signed cookie sessions with CSRF protection: createApp({ auth: sessions({ secret, user }) }). */
export function sessions(options: SessionsOptions): Sessions {
  if (!options || typeof options !== "object") throw new InferloError("IL6029", "sessions() needs { secret, user }.", { fix });
  const secrets = typeof options.secret === "string" ? [options.secret] : Array.isArray(options.secret) ? [...options.secret] : [];
  if (!secrets.length || secrets.some((s) => typeof s !== "string" || s.length < 32)) {
    throw new InferloError("IL6029", "sessions() secret must be a string of at least 32 characters (or a list of them, newest first).", { fix });
  }
  if (typeof options.user !== "function") throw new InferloError("IL6029", "sessions() needs a user({ userId }, { db }) function that loads the signed-in user.", { fix });
  const maxAgeMs = options.maxAgeMs ?? 7 * DAY;
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 60_000 || maxAgeMs > 400 * DAY) {
    throw new InferloError("IL6029", "sessions() maxAgeMs must be a whole number of milliseconds from 60000 (1 minute) to 34560000000 (400 days).", { fix });
  }
  const cookie = options.cookie ?? {};
  const name = cookie.name ?? "inferlo_session";
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) throw new InferloError("IL6029", `sessions() cookie name "${name}" is not a valid cookie name.`, { fix: 'Use letters, digits, "-" and "_", such as "app_session".' });
  if (cookie.sameSite !== undefined && cookie.sameSite !== "lax" && cookie.sameSite !== "strict") {
    throw new InferloError("IL6029", 'sessions() cookie.sameSite must be "lax" or "strict".', { fix: 'Use sameSite: "lax" (the default) or "strict".' });
  }
  for (const key of ["domain", "path"] as const) {
    const value = cookie[key];
    if (value !== undefined && (typeof value !== "string" || !value || /[;,\s]/.test(value))) {
      throw new InferloError("IL6029", `sessions() cookie.${key} must be a non-empty string without spaces, commas or semicolons.`, { fix });
    }
  }
  const csrfName = `${name}_csrf`;
  const sameSite = cookie.sameSite === "strict" ? "Strict" : "Lax";
  const path = cookie.path ?? "/";
  const keys = secrets.map((secret) => crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));

  const sign = async (key: Promise<CryptoKey>, text: string) => base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(text))));
  const csrfFor = (sessionId: string) => sign(keys[0]!, `csrf.${sessionId}`);

  const attributes = (url: URL, httpOnly: boolean, maxAge: number) => {
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const secure = cookie.secure ?? !local;
    return [`Path=${path}`, cookie.domain ? `Domain=${cookie.domain}` : "", `Max-Age=${maxAge}`, httpOnly ? "HttpOnly" : "", secure ? "Secure" : "", `SameSite=${sameSite}`].filter(Boolean).join("; ");
  };

  /** The verified session of a request, or null. */
  const read = async (req: Request): Promise<{ data: SessionData; sessionId: string } | null> => {
    const value = readCookie(req.headers.get("cookie"), name);
    if (!value) return null;
    const [version, payload, signature, extra] = value.split(".");
    if (version !== "v1" || !payload || !signature || extra !== undefined) return null;
    let valid = false;
    for (const key of keys) if (safeEqual(await sign(key, `v1.${payload}`), signature)) valid = true;
    if (!valid) return null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(unbase64url(payload))) as { u?: unknown; s?: unknown; i?: unknown; e?: unknown };
      if (typeof parsed.u !== "string" || typeof parsed.s !== "string" || typeof parsed.i !== "number" || typeof parsed.e !== "number") return null;
      if (parsed.e <= Date.now()) return null;
      return { data: { userId: parsed.u, issuedAt: parsed.i }, sessionId: parsed.s };
    } catch {
      return null;
    }
  };

  const session: Sessions = {
    async resolve(req, { db }) {
      const current = await read(req);
      if (!current) return null;
      if (!SAFE_METHODS.has(req.method.toUpperCase())) {
        const sent = req.headers.get("x-csrf-token") ?? (await formField(req, "_csrf"));
        if (!sent || !safeEqual(sent, await csrfFor(current.sessionId))) {
          throw new InferloError("IL3005", "Missing or invalid CSRF token.", {
            status: 403,
            fix: "Send the session's CSRF token in an X-CSRF-Token header (from session.signIn or the " + csrfName + " cookie) or a _csrf form field (from session.csrfToken(req)).",
          });
        }
      }
      return (await options.user(current.data, { db, req })) ?? null;
    },
    roles: options.roles,
    tenant: options.tenant,
    async signIn(ctx, userId) {
      if (typeof userId !== "string" || !userId) throw new InferloError("IL6029", "session.signIn(ctx, userId) needs the user's id as a non-empty string.", { fix: "Call it after checking the password: await session.signIn(ctx, user.id)." });
      if (!ctx || typeof ctx.header !== "function" || !(ctx.url instanceof URL)) throw new InferloError("IL6029", "session.signIn(ctx, userId) needs the route context.", { fix: "Pass the handler's context: route.post(\"/login\", ...).handle(async (ctx) => { await session.signIn(ctx, user.id) })." });
      const now = Date.now();
      const sessionId = base64url(crypto.getRandomValues(new Uint8Array(18)));
      const payload = base64url(new TextEncoder().encode(JSON.stringify({ u: userId, s: sessionId, i: now, e: now + maxAgeMs })));
      const value = `v1.${payload}.${await sign(keys[0]!, `v1.${payload}`)}`;
      const csrfToken = await csrfFor(sessionId);
      const seconds = Math.floor(maxAgeMs / 1000);
      ctx.header("set-cookie", `${name}=${value}; ${attributes(ctx.url, true, seconds)}`);
      ctx.header("set-cookie", `${csrfName}=${csrfToken}; ${attributes(ctx.url, false, seconds)}`);
      return { csrfToken };
    },
    signOut(ctx) {
      if (!ctx || typeof ctx.header !== "function" || !(ctx.url instanceof URL)) throw new InferloError("IL6029", "session.signOut(ctx) needs the route context.", { fix: "Pass the handler's context: session.signOut(ctx)." });
      ctx.header("set-cookie", `${name}=; ${attributes(ctx.url, true, 0)}`);
      ctx.header("set-cookie", `${csrfName}=; ${attributes(ctx.url, false, 0)}`);
    },
    async csrfToken(req) {
      const current = await read(req);
      return current ? csrfFor(current.sessionId) : null;
    },
  };
  return Object.freeze(session);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** A field of a URL-encoded form body, read from a copy of the request (at most 64 KiB) so the route can still read it. */
async function formField(req: Request, field: string): Promise<string | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/x-www-form-urlencoded")) return null;
  if (Number(req.headers.get("content-length") ?? "0") > MAX_FORM_BYTES) return null;
  // Cloned before req.body is touched: on Bun 1.3, a body stream read before clone() comes back empty.
  const body = req.clone().body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= MAX_FORM_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (size > MAX_FORM_BYTES) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes)).get(field);
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unbase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
