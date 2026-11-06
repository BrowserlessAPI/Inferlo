/**
 * Auth helpers. Inferlo does not force a login system on you: auth.resolve(req) returns the user.
 *
 *   auth: bearer(async (token, { db }) => {
 *     const key = await db.api_keys.findOne({ hash: await hashToken(token) })
 *     return key ? db.users.find(key.userId) : null
 *   })
 */
import type { AuthConfig } from "./app.ts";
import type { AppDb, AppUser } from "./route.ts";

type Verify = (token: string, ctx: { db: AppDb; req: Request }) => AppUser | null | undefined | Promise<AppUser | null | undefined>;

/** Read "Authorization: Bearer <token>" (or an x-api-key header) and verify it. */
export function bearer(verify: Verify, options: { roles?: (user: AppUser) => string[]; tenant?: (user: AppUser) => string | null | undefined; header?: string } = {}): AuthConfig {
  return {
    async resolve(req, { db }) {
      let token: string | undefined;
      const authorization = req.headers.get("authorization");
      if (authorization?.toLowerCase().startsWith("bearer ")) token = authorization.slice(7).trim();
      token ??= req.headers.get(options.header ?? "x-api-key") ?? undefined;
      if (!token) return null;
      return (await verify(token, { db, req })) ?? null;
    },
    roles: options.roles,
    tenant: options.tenant,
  };
}

/** SHA-256 hex digest. Store hashes of API keys, never the keys themselves. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random URL-safe token, e.g. for API keys: createToken("kr_live"). */
export function createToken(prefix = "", bytes = 24): string {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  const body = btoa(String.fromCharCode(...random)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return prefix ? `${prefix}_${body}` : body;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Password hashing with PBKDF2-SHA256 (Web Crypto, works on every runtime). */
export async function hashPassword(password: string, iterations = 210_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2_sha256" || !iter || !salt || !hash) return false;
  const actual = await pbkdf2(password, unb64(salt), Number(iter));
  return safeEqual(b64(actual), hash);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
