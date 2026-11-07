/**
 * Access tokens (JWTs) from an OpenID Connect provider as the app's auth: Auth0, Okta, Microsoft Entra ID, Google,
 * Keycloak, Clerk, WorkOS, Cognito, Supabase and any other issuer that publishes its signing keys (JWKS).
 *
 *   createApp({
 *     auth: jwt({
 *       issuer: "https://acme.eu.auth0.com/",
 *       audience: "https://api.acme.com",
 *       user: (claims) => ({ id: claims.sub, email: claims.email, roles: claims.permissions ?? [] }),
 *     }),
 *   });
 *
 * Requests send "Authorization: Bearer <token>". The signature is checked with Web Crypto against the issuer's
 * keys (found through its OpenID configuration, or jwksUrl), then the issuer, audience, expiry and not-before
 * times. Tokens that fail any check sign nobody in (401). No runtime dependencies; runs on every runtime.
 */
import type { AuthConfig } from "./app.ts";
import { InferloError } from "./errors.ts";
import type { AppDb, AppUser } from "./route.ts";

/** The claims of a verified token. Providers add their own (email, roles, permissions, org_id, scope, ...). */
export interface JwtClaims {
  /** The user (subject) the token was issued for. */
  sub: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  [claim: string]: unknown;
}

export type JwtAlgorithm = "RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512" | "ES256" | "ES384" | "ES512" | "EdDSA" | "Ed25519" | "HS256" | "HS384" | "HS512";

export interface JwtOptions {
  /** The issuer (the iss claim) exactly as the provider writes it, such as "https://acme.eu.auth0.com/". */
  issuer: string;
  /** The audience (aud claim) this API accepts: its identifier at the provider. A list accepts any of them. */
  audience: string | string[];
  /**
   * Where the issuer's signing keys are (a JSON Web Key Set). Default: the jwks_uri of the issuer's OpenID
   * configuration (<issuer>/.well-known/openid-configuration). Must be https, except on localhost.
   */
  jwksUrl?: string;
  /** For providers that sign with a shared secret (HS256), at least 32 characters, instead of keys. */
  secret?: string;
  /** Algorithms to accept. Default: every asymmetric algorithm (RS, PS, ES, EdDSA), or HS256 with secret. */
  algorithms?: JwtAlgorithm[];
  /** The app's user for a verified token, or null to refuse it. Default: { id: sub, email, name, roles }. */
  user?: (claims: JwtClaims, ctx: { db: AppDb; req: Request }) => AppUser | null | undefined | Promise<AppUser | null | undefined>;
  /** Allowed clock difference with the issuer, in seconds, for exp, nbf and iat. Default 60, at most 300. */
  clockToleranceSeconds?: number;
  /** How long fetched keys are kept, in milliseconds. Default 10 minutes, from 1 minute to 1 day. */
  cacheMs?: number;
  /** Roles of a user, checked when a route uses auth: "<role>". Default: user.roles ?? []. */
  roles?: (user: AppUser) => string[];
  /** The tenant of a user, for tenant-scoped models. Default: user.tenantId. */
  tenant?: (user: AppUser) => string | null | undefined;
}

export const ASYMMETRIC: JwtAlgorithm[] = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519"];
const HMAC: JwtAlgorithm[] = ["HS256", "HS384", "HS512"];
const OPTIONS = ["issuer", "audience", "jwksUrl", "secret", "algorithms", "user", "clockToleranceSeconds", "cacheMs", "roles", "tenant"];
const MAX_TOKEN = 16 * 1024;
const FETCH_TIMEOUT = 5000;
/** A token with an unknown key id fetches the keys again, but not more often than this. */
const REFETCH_COOLDOWN = 30_000;
const fix = 'Use jwt({ issuer: "https://login.example.com/", audience: "https://api.example.com" }), with the issuer and audience your identity provider shows for this API.';

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  crv?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
}

function invalid(message: string, fixText = fix): InferloError {
  return new InferloError("IL6042", message, { fix: fixText });
}

export function isLocal(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function checkUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`jwt() ${what} must be a URL, got ${JSON.stringify(value)}.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url))) {
    throw invalid(`jwt() ${what} must use https (plain http only on localhost), got ${JSON.stringify(value)}.`);
  }
  return url;
}

function base64urlBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function decodeJson(text: string): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(base64urlBytes(text))) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

const HASH: Record<string, string> = { "256": "SHA-256", "384": "SHA-384", "512": "SHA-512" };

/** Web Crypto import and verify parameters for an algorithm, or null when the key does not fit it. */
function cryptoParams(alg: JwtAlgorithm, jwk?: Jwk): { importAlg: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams; verifyAlg: AlgorithmIdentifier | RsaPssParams | EcdsaParams } | null {
  const bits = alg.slice(2);
  if (alg.startsWith("RS")) {
    if (jwk && jwk.kty !== "RSA") return null;
    return { importAlg: { name: "RSASSA-PKCS1-v1_5", hash: HASH[bits]! }, verifyAlg: { name: "RSASSA-PKCS1-v1_5" } };
  }
  if (alg.startsWith("PS")) {
    if (jwk && jwk.kty !== "RSA") return null;
    return { importAlg: { name: "RSA-PSS", hash: HASH[bits]! }, verifyAlg: { name: "RSA-PSS", saltLength: Number(bits) / 8 } };
  }
  if (alg.startsWith("ES")) {
    const curve = { ES256: "P-256", ES384: "P-384", ES512: "P-521" }[alg as "ES256"];
    if (jwk && (jwk.kty !== "EC" || jwk.crv !== curve)) return null;
    return { importAlg: { name: "ECDSA", namedCurve: curve }, verifyAlg: { name: "ECDSA", hash: HASH[bits]! } };
  }
  if (alg === "EdDSA" || alg === "Ed25519") {
    if (jwk && (jwk.kty !== "OKP" || jwk.crv !== "Ed25519")) return null;
    return { importAlg: { name: "Ed25519" }, verifyAlg: { name: "Ed25519" } };
  }
  return null;
}

/** Only the public parts of a key, so Web Crypto does not reject it over use, key_ops or alg fields. */
function publicJwk(jwk: Jwk): JsonWebKey {
  if (jwk.kty === "RSA") return { kty: "RSA", n: jwk.n, e: jwk.e, ext: true };
  if (jwk.kty === "EC") return { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true };
  return { kty: "OKP", crv: jwk.crv, x: jwk.x, ext: true };
}

function defaultUser(claims: JwtClaims): AppUser {
  const roles = Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === "string") : [];
  const user: Record<string, unknown> = { id: claims.sub, roles };
  if (typeof claims.email === "string") user.email = claims.email;
  if (typeof claims.name === "string") user.name = claims.name;
  // Apps that register their own user type (Register) map the claims with options.user.
  return user as AppUser;
}

/**
 * The app's auth from access tokens (JWTs) of an OpenID Connect provider: createApp({ auth: jwt({ issuer,
 * audience }) }). Requests send Authorization: Bearer <token>.
 */
export function jwt(options: JwtOptions): AuthConfig {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw invalid("jwt() needs { issuer, audience }.");
  for (const key of Object.keys(options)) if (!OPTIONS.includes(key)) throw invalid(`jwt() has no option "${key}".`, `Use ${OPTIONS.join(", ")}.`);
  if (typeof options.issuer !== "string" || !options.issuer) throw invalid("jwt() needs the issuer: the iss claim of the provider's tokens.");
  const audiences = typeof options.audience === "string" ? [options.audience] : Array.isArray(options.audience) ? options.audience : [];
  if (!audiences.length || audiences.some((a) => typeof a !== "string" || !a)) {
    throw invalid("jwt() needs the audience: this API's identifier at the provider (the aud claim of its tokens), so tokens issued for other apps are refused.");
  }
  for (const key of ["user", "roles", "tenant"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") throw invalid(`jwt() ${key} must be a function.`);
  }
  const secret = options.secret;
  if (secret !== undefined) {
    if (typeof secret !== "string" || secret.length < 32) throw invalid("jwt() secret must be a string of at least 32 characters.", "Keep the provider's signing secret in config({ secrets }) and pass it as secret.");
    if (options.jwksUrl !== undefined) throw invalid("jwt() takes a secret or a jwksUrl, not both.");
  }
  const allowed = options.algorithms ?? (secret === undefined ? ASYMMETRIC : ["HS256"]);
  if (!Array.isArray(allowed) || !allowed.length || allowed.some((a) => ![...ASYMMETRIC, ...HMAC].includes(a))) {
    throw invalid(`jwt() algorithms must be a list of ${[...ASYMMETRIC, ...HMAC].join(", ")}.`);
  }
  if (secret === undefined && allowed.some((a) => HMAC.includes(a))) throw invalid("jwt() algorithms HS256, HS384 and HS512 need a secret.");
  if (secret !== undefined && allowed.some((a) => !HMAC.includes(a))) throw invalid("jwt() with a secret accepts only HS256, HS384 or HS512.");
  const tolerance = options.clockToleranceSeconds ?? 60;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 300) throw invalid("jwt() clockToleranceSeconds must be a whole number from 0 to 300.");
  const cacheMs = options.cacheMs ?? 600_000;
  if (!Number.isInteger(cacheMs) || cacheMs < 60_000 || cacheMs > 86_400_000) throw invalid("jwt() cacheMs must be a whole number of milliseconds from 60000 (1 minute) to 86400000 (1 day).");
  const issuer = options.issuer;
  const jwksUrl = options.jwksUrl === undefined ? undefined : checkUrl(options.jwksUrl, "jwksUrl").href;
  if (secret === undefined && jwksUrl === undefined) checkUrl(issuer, "issuer");
  const toUser = options.user ?? defaultUser;

  const verify = createJwtVerifier({ issuer, audiences, secret, allowed, tolerance, cacheMs, jwksUrl });

  return {
    async resolve(req, { db }) {
      const authorization = req.headers.get("authorization");
      if (!authorization || !/^bearer\s+/i.test(authorization)) return null;
      const claims = await verify(authorization.replace(/^bearer\s+/i, "").trim());
      if (!claims) return null;
      return (await toUser(claims, { db, req })) ?? null;
    },
    ...(options.roles ? { roles: options.roles } : {}),
    ...(options.tenant ? { tenant: options.tenant } : {}),
  };
}

/** What createJwtVerifier needs: the checked options of jwt(), or of oidc() for ID tokens. */
export interface JwtVerifierConfig {
  issuer: string;
  audiences: string[];
  secret?: string;
  allowed: JwtAlgorithm[];
  tolerance: number;
  cacheMs: number;
  jwksUrl?: string;
  /** Finds the key set's URL another way (oidc() shares its OpenID configuration). Default: the issuer's discovery. */
  discoverJwksUrl?: () => Promise<string>;
}

/**
 * Verifies JWTs for an issuer and audience: the signature against the issuer's keys (cached, fetched again for a
 * rotated key) or a shared secret, then iss, aud, exp, nbf, iat and sub. Resolves to the claims, or null for any
 * token that is not valid. Throws 503 IL3008 when no keys could ever be loaded. Internal: used by jwt() and oidc().
 */
export function createJwtVerifier(config: JwtVerifierConfig): (token: string) => Promise<JwtClaims | null> {
  const { issuer, audiences, secret, allowed, tolerance, cacheMs, jwksUrl } = config;
  // Signing keys: fetched on first use, kept for cacheMs, and fetched again (at most every 30 s) for an unknown key id.
  let keys: Jwk[] | undefined;
  let fetchedAt = 0;
  let loading: Promise<Jwk[]> | undefined;
  const imported = new Map<string, Promise<CryptoKey>>();
  const hmacKeys = new Map<string, Promise<CryptoKey>>();

  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${url} did not answer a JSON object`);
    return body as Record<string, unknown>;
  };

  const load = async (): Promise<Jwk[]> => {
    let url = jwksUrl;
    if (!url && config.discoverJwksUrl) url = await config.discoverJwksUrl();
    if (!url) {
      const discovery = await getJson(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
      if (discovery.issuer !== issuer) throw new Error(`the OpenID configuration names the issuer ${JSON.stringify(discovery.issuer)}, not ${JSON.stringify(issuer)}`);
      if (typeof discovery.jwks_uri !== "string") throw new Error("the OpenID configuration has no jwks_uri");
      url = checkUrl(discovery.jwks_uri, "jwks_uri").href;
    }
    const set = await getJson(url);
    if (!Array.isArray(set.keys)) throw new Error(`${url} is not a JSON Web Key Set`);
    return (set.keys as unknown[]).filter((k): k is Jwk => Boolean(k) && typeof k === "object" && (k as Jwk).use !== "enc");
  };

  const refresh = (): Promise<Jwk[]> => {
    loading ??= load()
      .then((found) => {
        keys = found;
        fetchedAt = Date.now();
        imported.clear();
        return found;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };

  const unavailable = (cause: unknown) =>
    new InferloError("IL3008", "The identity provider's signing keys could not be loaded, so the token cannot be checked.", {
      status: 503,
      fix: `Check that ${jwksUrl ?? `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`} is reachable from the server and answers the provider's keys (${cause instanceof Error ? cause.message : String(cause)}).`,
    });

  const candidates = async (kid: string | undefined, alg: JwtAlgorithm): Promise<Jwk[]> => {
    const match = (list: Jwk[]) => list.filter((k) => (kid === undefined || k.kid === kid) && (k.alg === undefined || k.alg === alg) && cryptoParams(alg, k) !== null);
    const stale = !keys || Date.now() - fetchedAt > cacheMs;
    if (stale) {
      try {
        await refresh();
      } catch (error) {
        // Keep using the keys we have while the provider cannot be reached; without any, nothing can be checked.
        if (!keys) throw unavailable(error);
        fetchedAt = Date.now() - cacheMs + REFETCH_COOLDOWN;
      }
    }
    let found = match(keys!);
    if (!found.length && kid !== undefined && Date.now() - fetchedAt > REFETCH_COOLDOWN) {
      // A key the provider started using since the last fetch (key rotation).
      try {
        found = match(await refresh());
      } catch {
        found = [];
      }
    }
    return found.slice(0, 10);
  };

  const keyFor = (jwk: Jwk, alg: JwtAlgorithm): Promise<CryptoKey> => {
    const id = `${alg}\u0000${jwk.kid ?? ""}\u0000${jwk.n ?? ""}${jwk.x ?? ""}${jwk.y ?? ""}`;
    let key = imported.get(id);
    if (!key) {
      key = crypto.subtle.importKey("jwk", publicJwk(jwk), cryptoParams(alg)!.importAlg, false, ["verify"]);
      key.catch(() => imported.delete(id));
      imported.set(id, key);
    }
    return key;
  };

  const hmacKey = (alg: JwtAlgorithm): Promise<CryptoKey> => {
    let key = hmacKeys.get(alg);
    if (!key) {
      key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: HASH[alg.slice(2)]! }, false, ["verify"]);
      hmacKeys.set(alg, key);
    }
    return key;
  };

  /** The verified claims of a token, or null for any token that is not valid for this API. */
  const verify = async (token: string): Promise<JwtClaims | null> => {
    if (token.length > MAX_TOKEN) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = decodeJson(headerPart);
      claims = decodeJson(payloadPart);
      signature = base64urlBytes(signaturePart);
    } catch {
      return null;
    }
    const alg = header.alg as JwtAlgorithm;
    if (typeof alg !== "string" || !allowed.includes(alg)) return null;
    // Extensions this verifier does not understand must not be ignored (RFC 7515, section 4.1.11).
    if (header.crit !== undefined) return null;
    if (header.kid !== undefined && typeof header.kid !== "string") return null;
    const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);

    let valid = false;
    if (secret !== undefined) {
      valid = await crypto.subtle.verify("HMAC", await hmacKey(alg), signature, data);
    } else {
      for (const jwk of await candidates(header.kid as string | undefined, alg)) {
        try {
          if (await crypto.subtle.verify(cryptoParams(alg)!.verifyAlg, await keyFor(jwk, alg), signature, data)) {
            valid = true;
            break;
          }
        } catch {
          // A key Web Crypto cannot use (a malformed key in the set) does not verify anything.
        }
      }
    }
    if (!valid) return null;

    const now = Date.now() / 1000;
    if (claims.iss !== issuer) return null;
    const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!aud.some((a) => audiences.includes(a as string))) return null;
    if (typeof claims.exp !== "number" || claims.exp + tolerance <= now) return null;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - tolerance > now)) return null;
    if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat - tolerance > now)) return null;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    return claims as JwtClaims;
  };

  return verify;
}
