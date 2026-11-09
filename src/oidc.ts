/**
 * Single sign-on for browser apps with OpenID Connect (Okta, Microsoft Entra ID, Google, Auth0, Keycloak, Ping,
 * OneLogin, JumpCloud, Authentik, Zitadel and any other OpenID provider): the authorization code flow with PKCE,
 * state and nonce, ending in a sessions() cookie.
 *
 *   export const session = sessions({ secret: settings.SESSION_SECRET, user: ({ userId }, { db }) => db.users.find(userId) });
 *   export const sso = oidc({
 *     issuer: "https://acme.okta.com",
 *     clientId: settings.OIDC_CLIENT_ID,
 *     clientSecret: settings.OIDC_CLIENT_SECRET,
 *     session,
 *     userId: async (claims, { db }) => (await db.users.findOne({ email: claims.email }))?.id ?? null,
 *   });
 *   createApp({ auth: session, routes: [notes, sso] });
 *
 * GET /auth/login (?returnTo=/path) sends the browser to the provider; GET /auth/callback checks what comes back
 * (state, the code exchanged with the PKCE verifier, the ID token's signature, issuer, audience, expiry and nonce),
 * asks userId(claims) which user signs in, starts the session and sends the browser back. POST /auth/logout ends the
 * session and signs the user out at the provider too (RP-initiated logout). No runtime dependencies.
 */
import { safeEqual } from "./auth.ts";
import { InferloError } from "./errors.ts";
import { ASYMMETRIC, createJwtVerifier, isLocal, type JwtClaims } from "./jwt.ts";
import { route, type AppDb, type RouteDef } from "./route.ts";
import type { Sessions } from "./sessions.ts";

/** The claims of a verified ID token. Providers add their own (email, email_verified, name, groups, tid, hd, ...). */
export interface OidcClaims extends JwtClaims {
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** The provider's answer to the code exchange. */
export interface OidcTokens {
  idToken: string;
  /** For calling the provider's APIs (userinfo, Microsoft Graph, ...); never stored by Inferlo. */
  accessToken?: string;
  refreshToken?: string;
  /** Seconds until the access token expires, as the provider says. */
  expiresIn?: number;
  scope?: string;
}

export interface OidcOptions {
  /** The provider's issuer exactly as its OpenID configuration names it, such as "https://acme.okta.com". https, except on localhost. */
  issuer: string;
  /** The app's client id at the provider. */
  clientId: string;
  /** The app's client secret (keep it in config({ secrets })). Leave it out for a public client, which PKCE protects. */
  clientSecret?: string;
  /** The sessions() the sign-in ends in; also the app's auth: createApp({ auth: session }). */
  session: Sessions;
  /**
   * The id of the app's user for a verified ID token (find or create the user), or null to refuse the sign-in
   * (403 IL3011). Check claims.email_verified before trusting claims.email.
   */
  userId: (claims: OidcClaims, ctx: { db: AppDb; req: Request; tokens: OidcTokens }) => string | null | undefined | Promise<string | null | undefined>;
  /** Where the provider sends the browser back, registered at the provider. Default: <the request's origin><basePath>/callback. */
  redirectUri?: string;
  /** Scopes to ask for. Default ["openid", "email", "profile"]; "openid" is always sent. */
  scopes?: string[];
  /** Where the login, callback and logout routes are. Default "/auth": GET /auth/login, GET /auth/callback and POST /auth/logout. */
  basePath?: string;
  /**
   * Extra parameters for every sign-in at the provider, such as { prompt: "select_account" }, Google's
   * { hd: "acme.com" } or Entra ID's { domain_hint: "acme.com" }. The flow's own parameters cannot be changed.
   */
  authorizationParams?: Record<string, string>;
  /** Where the provider sends the browser after signing out, registered at the provider. Default: <the request's origin>/. */
  postLogoutRedirectUri?: string;
}

/** routes: [sso] adds the two routes; oidcLogin starts a sign-in, oidcCallback finishes it. */
export type Oidc = {
  /** GET <basePath>/login?returnTo=/path: sends the browser to the provider. */
  oidcLogin: RouteDef;
  /** GET <basePath>/callback: the redirect URI registered at the provider. */
  oidcCallback: RouteDef;
  /** POST <basePath>/logout (with the session's _csrf field): ends the session, then signs out at the provider. */
  oidcLogout: RouteDef;
  /** The login route's path, for links: <a href={sso.loginPath}>. */
  loginPath: string;
  /** The logout route's path, for a form: <form method="post" action={sso.logoutPath}>. */
  logoutPath: string;
};

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: unknown;
  /** Where to sign out at the provider (RP-initiated logout); Google, for one, has none. */
  end_session_endpoint?: string;
}

interface Pending {
  /** state */
  s: string;
  /** nonce */
  n: string;
  /** PKCE code verifier */
  v: string;
  /** returnTo */
  r: string;
  /** expires (ms since 1970) */
  e: number;
}

const OPTIONS = ["issuer", "clientId", "clientSecret", "session", "userId", "redirectUri", "scopes", "basePath", "authorizationParams", "postLogoutRedirectUri"];
/** The parameters oidc() sets itself, which authorizationParams cannot change. */
const RESERVED_PARAMS = ["response_type", "client_id", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "response_mode", "request", "request_uri"];
/** The prompt values a login link may ask for with ?prompt= (OpenID Connect Core and Initiating User Registration). */
const PROMPTS = ["none", "login", "consent", "select_account", "create"];
/** ID tokens up to this size are kept for signing out at the provider; larger ones would not fit in a cookie. */
const MAX_ID_TOKEN_COOKIE = 3500;
/** How long the ID token is kept for signing out (the longest a sessions() cookie can last). */
const ID_TOKEN_COOKIE_SECONDS = 400 * 86_400;
const FETCH_TIMEOUT = 5000;
const DISCOVERY_CACHE_MS = 600_000;
const PENDING_MS = 600_000;
const fix =
  'Use oidc({ issuer: "https://login.example.com", clientId: settings.OIDC_CLIENT_ID, clientSecret: settings.OIDC_CLIENT_SECRET, session, userId: (claims, { db }) => ... }) with the issuer, client id and secret your identity provider shows for this app.';

function invalid(message: string, fixText = fix): InferloError {
  return new InferloError("IL6047", message, { fix: fixText });
}

function failed(reason: string): InferloError {
  return new InferloError("IL3009", `The sign-in could not be completed: ${reason}.`, {
    status: 400,
    fix: "Start the sign-in again from the app's login link, in the same browser. If it keeps failing, check the app's OpenID Connect settings (issuer, client id, redirect URI) at the provider.",
  });
}

function unreachable(what: string, cause: unknown): InferloError {
  return new InferloError("IL3010", `The identity provider could not be used: ${what}.`, {
    status: 502,
    fix: `Check that the issuer, client id and client secret are right and that the provider is reachable from the server (${cause instanceof Error ? cause.message : String(cause)}).`,
  });
}

function httpsUrl(value: unknown, what: string): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw invalid(`oidc() ${what} must be a URL, got ${JSON.stringify(value)}.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url))) {
    throw invalid(`oidc() ${what} must use https (plain http only on localhost), got ${JSON.stringify(value)}.`);
  }
  return url;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function random(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A path on this app to return to after the sign-in, or "/": never another site (open redirect). */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || value.length > 2000) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return "/";
  return value;
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * The short-lived cookie that carries state, nonce and the PKCE verifier from login to callback ("inferlo_oidc"),
 * and the one that keeps the ID token for signing out at the provider ("inferlo_oidc_id").
 */
export function cookieFor(url: URL, base = "inferlo_oidc"): { name: string; attributes: string } {
  const local = url.protocol === "http:" && isLocal(url);
  // __Host- cookies cannot be set by subdomains or for other paths; browsers need Secure for them.
  return local ? { name: base, attributes: "Path=/; HttpOnly; SameSite=Lax" } : { name: `__Host-${base}`, attributes: "Path=/; HttpOnly; Secure; SameSite=Lax" };
}

/** The iss claim of a JWT, without checking it (only to pick the provider an ID token came from). */
function issuerOf(token: string): string | undefined {
  try {
    const payload = token.split(".")[1] ?? "";
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as { iss?: unknown };
    return typeof claims.iss === "string" ? claims.iss : undefined;
  } catch {
    return undefined;
  }
}

/**
 * OpenID Connect sign-in for browser apps: routes: [sso] with sso = oidc({ issuer, clientId, clientSecret,
 * session, userId }). The sign-in ends in the session's cookie.
 */
export function oidc(options: OidcOptions): Oidc {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw invalid("oidc() needs { issuer, clientId, session, userId }.");
  for (const key of Object.keys(options)) if (!OPTIONS.includes(key)) throw invalid(`oidc() has no option "${key}".`, `Use ${OPTIONS.join(", ")}.`);
  if (typeof options.issuer !== "string" || !options.issuer) throw invalid("oidc() needs the issuer: the provider's URL as its OpenID configuration names it.");
  httpsUrl(options.issuer, "issuer");
  if (typeof options.clientId !== "string" || !options.clientId) throw invalid("oidc() needs the clientId the provider gave this app.");
  if (options.clientSecret !== undefined && (typeof options.clientSecret !== "string" || !options.clientSecret)) {
    throw invalid("oidc() clientSecret must be a non-empty string, or left out for a public client.", "Keep the client secret in config({ secrets }) and pass it as clientSecret.");
  }
  const session = options.session;
  if (!session || typeof session !== "object" || typeof session.signIn !== "function" || typeof session.resolve !== "function") {
    throw invalid("oidc() needs session: the sessions() the sign-in ends in.", "Pass session = sessions({ secret, user }), and use it as the app's auth too: createApp({ auth: session }).");
  }
  if (typeof options.userId !== "function") throw invalid("oidc() needs userId(claims, { db }): the id of the app's user for a verified sign-in, or null to refuse it.");
  const redirectUri = options.redirectUri === undefined ? undefined : httpsUrl(options.redirectUri, "redirectUri").href;
  const scopes = options.scopes ?? ["openid", "email", "profile"];
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s))) {
    throw invalid('oidc() scopes must be a list of scope names, such as ["openid", "email", "profile"].');
  }
  const scope = [...new Set(["openid", ...scopes])].join(" ");
  const basePath = options.basePath ?? "/auth";
  if (typeof basePath !== "string" || !/^\/[A-Za-z0-9._~\-/]*$/.test(basePath) || basePath.includes("//") || !basePath.replace(/\/+$/, "")) {
    throw invalid(`oidc() basePath must be a path such as "/auth", got ${JSON.stringify(basePath)}.`);
  }
  const base = basePath.replace(/\/+$/, "");
  const extraParams = options.authorizationParams ?? {};
  if (!extraParams || typeof extraParams !== "object" || Array.isArray(extraParams)) {
    throw invalid('oidc() authorizationParams must be an object of parameter names and string values, such as { prompt: "select_account" }.');
  }
  for (const [key, value] of Object.entries(extraParams)) {
    if (RESERVED_PARAMS.includes(key)) {
      throw invalid(`oidc() authorizationParams cannot set "${key}": oidc() sets it itself.`, `Leave "${key}" out of authorizationParams; use scopes for the scope and redirectUri for the redirect URI.`);
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || typeof value !== "string" || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw invalid(`oidc() authorizationParams.${key} must be a string of at most 1000 characters without control characters, under a parameter name such as "prompt" or "domain_hint".`);
    }
  }
  const postLogoutRedirectUri = options.postLogoutRedirectUri === undefined ? undefined : httpsUrl(options.postLogoutRedirectUri, "postLogoutRedirectUri").href;
  const { issuer, clientId, clientSecret } = options;

  // The provider's OpenID configuration: fetched on first use, kept for 10 minutes, and kept longer while the
  // provider cannot be reached.
  let discovered: { value: Discovery; at: number } | undefined;
  let loading: Promise<Discovery> | undefined;
  const loadDiscovery = async (): Promise<Discovery> => {
    const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const body = (await response.json()) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new Error(`${url} did not answer a JSON object`);
    if (body.issuer !== issuer) throw new Error(`the OpenID configuration names the issuer ${JSON.stringify(body.issuer)}, not ${JSON.stringify(issuer)}`);
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof body[key] !== "string") throw new Error(`the OpenID configuration has no ${key}`);
      httpsUrl(body[key], key);
    }
    if (body.end_session_endpoint !== undefined) {
      if (typeof body.end_session_endpoint !== "string") throw new Error("the OpenID configuration's end_session_endpoint is not a URL");
      httpsUrl(body.end_session_endpoint, "end_session_endpoint");
    }
    return body as unknown as Discovery;
  };
  const discovery = async (): Promise<Discovery> => {
    if (discovered && Date.now() - discovered.at < DISCOVERY_CACHE_MS) return discovered.value;
    try {
      loading ??= loadDiscovery().finally(() => (loading = undefined));
      const value = await loading;
      discovered = { value, at: Date.now() };
      return value;
    } catch (error) {
      if (discovered) return discovered.value;
      throw unreachable("its OpenID configuration could not be loaded", error);
    }
  };

  const verifyIdToken = createJwtVerifier({
    issuer,
    audiences: [clientId],
    allowed: ASYMMETRIC,
    tolerance: 60,
    cacheMs: DISCOVERY_CACHE_MS,
    discoverJwksUrl: async () => (await discovery()).jwks_uri,
  });

  const callbackUrl = (url: URL) => redirectUri ?? new URL(`${base}/callback`, url).href;

  const start = async (ctx: { url: URL; header(name: string, value: string): void }): Promise<Response> => {
    const config = await discovery();
    const pending: Pending = { s: random(), n: random(), v: random(), r: safeReturnTo(ctx.url.searchParams.get("returnTo")), e: Date.now() + PENDING_MS };
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.v))));
    const target = new URL(config.authorization_endpoint);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("redirect_uri", callbackUrl(ctx.url));
    target.searchParams.set("scope", scope);
    target.searchParams.set("state", pending.s);
    target.searchParams.set("nonce", pending.n);
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    for (const [key, value] of Object.entries(extraParams)) target.searchParams.set(key, value);
    // Per sign-in: ?loginHint= fills in the user's name at the provider, ?prompt= asks it to show the login or
    // account picker again. Anything else in the query is ignored.
    const loginHint = ctx.url.searchParams.get("loginHint");
    if (loginHint && loginHint.length <= 256 && !/[\u0000-\u001f\u007f]/.test(loginHint)) target.searchParams.set("login_hint", loginHint);
    const prompt = ctx.url.searchParams.get("prompt");
    if (prompt && prompt.split(" ").every((p) => PROMPTS.includes(p))) target.searchParams.set("prompt", prompt);
    const cookie = cookieFor(ctx.url);
    ctx.header("set-cookie", `${cookie.name}=${base64url(new TextEncoder().encode(JSON.stringify(pending)))}; ${cookie.attributes}; Max-Age=${PENDING_MS / 1000}`);
    ctx.header("cache-control", "no-store");
    return new Response(null, { status: 302, headers: { location: target.href } });
  };

  const exchange = async (config: Discovery, code: string, verifier: string, url: URL): Promise<OidcTokens> => {
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl(url), code_verifier: verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const methods = Array.isArray(config.token_endpoint_auth_methods_supported) ? config.token_endpoint_auth_methods_supported : undefined;
    if (clientSecret === undefined) form.set("client_id", clientId);
    else if (methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
      form.set("client_id", clientId);
      form.set("client_secret", clientSecret);
    } else {
      // client_secret_basic, the default of OpenID Connect: both parts form-encoded first (RFC 6749, section 2.3.1).
      const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, "+");
      headers.authorization = `Basic ${btoa(`${encode(clientId)}:${encode(clientSecret)}`)}`;
    }
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await fetch(config.token_endpoint, { method: "POST", headers, body: form.toString(), redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      body = ((await response.json()) as Record<string, unknown> | null) ?? {};
    } catch (error) {
      throw unreachable("its token endpoint did not answer", error);
    }
    if (!response.ok) {
      const error = typeof body.error === "string" && /^[\w.-]{1,64}$/.test(body.error) ? body.error : `status ${response.status}`;
      // A wrong client id or secret is the app's configuration; anything else (a used or expired code) is this sign-in.
      if (error === "invalid_client" || error === "unauthorized_client" || response.status >= 500) throw unreachable(`its token endpoint refused the code exchange (${error})`, error);
      throw failed(`the identity provider refused the code (${error})`);
    }
    if (typeof body.id_token !== "string") throw failed("the identity provider sent no ID token (is the openid scope allowed for this app?)");
    const tokens: OidcTokens = { idToken: body.id_token };
    if (typeof body.access_token === "string") tokens.accessToken = body.access_token;
    if (typeof body.refresh_token === "string") tokens.refreshToken = body.refresh_token;
    if (typeof body.expires_in === "number") tokens.expiresIn = body.expires_in;
    if (typeof body.scope === "string") tokens.scope = body.scope;
    return tokens;
  };

  const finish = async (ctx: { url: URL; req: Request; db: AppDb; header(name: string, value: string): void }): Promise<Response> => {
    const params = ctx.url.searchParams;
    const cookie = cookieFor(ctx.url);
    // The pending sign-in is used once, whatever happens.
    ctx.header("set-cookie", `${cookie.name}=; ${cookie.attributes}; Max-Age=0`);
    ctx.header("cache-control", "no-store");
    let pending: Pending | undefined;
    try {
      const raw = readCookie(ctx.req.headers.get("cookie"), cookie.name);
      if (raw && raw.length < 4096) {
        const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as Pending;
        if (["s", "n", "v", "r"].every((k) => typeof parsed[k as keyof Pending] === "string") && typeof parsed.e === "number") pending = parsed;
      }
    } catch {
      pending = undefined;
    }
    if (!pending || pending.e <= Date.now()) throw failed("it expired or was started in another browser");
    const state = params.get("state");
    if (!state || !safeEqual(state, pending.s)) throw failed("the state does not match the sign-in this browser started");
    // RFC 9207: a provider that names itself in the redirect must be the configured one (mix-up attacks).
    const iss = params.get("iss");
    if (iss !== null && iss !== issuer) throw failed("the answer came from another identity provider");
    const error = params.get("error");
    if (error !== null) throw failed(`the identity provider answered ${/^[\w.-]{1,64}$/.test(error) ? error : "an error"}`);
    const code = params.get("code");
    if (!code) throw failed("the identity provider sent no code");

    const config = await discovery();
    const tokens = await exchange(config, code, pending.v, ctx.url);
    const claims = (await verifyIdToken(tokens.idToken)) as OidcClaims | null;
    if (!claims) throw failed("the ID token is not valid for this app (signature, issuer, audience or expiry)");
    if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, pending.n)) throw failed("the ID token's nonce does not match this sign-in");
    if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) throw failed("the ID token was issued to another app");

    const userId = await options.userId(claims, { db: ctx.db, req: ctx.req, tokens });
    if (userId === null || userId === undefined) {
      throw new InferloError("IL3011", "This account may not sign in to the app.", { status: 403, fix: "Ask an administrator of the app for access." });
    }
    if (typeof userId !== "string" || !userId) {
      throw new InferloError("IL6047", "oidc() userId must return the user's id as a non-empty string, or null to refuse the sign-in.", { fix: "Return the id of the app's user: userId: async (claims, { db }) => (await db.users.findOne({ email: claims.email }))?.id ?? null." });
    }
    await session.signIn(ctx, userId);
    // The ID token is kept (HttpOnly) for signing out at the provider later, as id_token_hint.
    const idCookie = cookieFor(ctx.url, "inferlo_oidc_id");
    if (tokens.idToken.length <= MAX_ID_TOKEN_COOKIE && /^[\w-]+\.[\w-]+\.[\w-]*$/.test(tokens.idToken)) {
      ctx.header("set-cookie", `${idCookie.name}=${tokens.idToken}; ${idCookie.attributes}; Max-Age=${ID_TOKEN_COOKIE_SECONDS}`);
    } else {
      ctx.header("set-cookie", `${idCookie.name}=; ${idCookie.attributes}; Max-Age=0`);
    }
    return new Response(null, { status: 302, headers: { location: pending.r } });
  };

  const logout = async (ctx: { url: URL; req: Request; db: AppDb; header(name: string, value: string): void }): Promise<Response> => {
    // A signed-in browser must send the session's CSRF token (IL3005), so other sites cannot sign users out.
    await session.resolve(ctx.req, { db: ctx.db, url: ctx.url });
    session.signOut(ctx);
    const idCookie = cookieFor(ctx.url, "inferlo_oidc_id");
    const idToken = readCookie(ctx.req.headers.get("cookie"), idCookie.name);
    ctx.header("set-cookie", `${idCookie.name}=; ${idCookie.attributes}; Max-Age=0`);
    ctx.header("cache-control", "no-store");
    const afterLogout = postLogoutRedirectUri ?? new URL("/", ctx.url).href;
    let endSession: string | undefined;
    try {
      endSession = (await discovery()).end_session_endpoint;
    } catch {
      // The app's session is over; a provider that cannot be reached cannot end its own.
      endSession = undefined;
    }
    if (!endSession) return new Response(null, { status: 303, headers: { location: afterLogout } });
    const target = new URL(endSession);
    // Only an ID token this provider issued is sent back to it (with several providers, each has its basePath).
    if (idToken && idToken.length <= MAX_ID_TOKEN_COOKIE && issuerOf(idToken) === issuer) target.searchParams.set("id_token_hint", idToken);
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("post_logout_redirect_uri", afterLogout);
    return new Response(null, { status: 303, headers: { location: target.href } });
  };

  return {
    oidcLogin: route.get(`${base}/login`, { auth: "public", summary: "Sign in with the identity provider (OpenID Connect)" }).handle(start),
    oidcCallback: route.get(`${base}/callback`, { auth: "public", summary: "Finish the sign-in with the identity provider (OpenID Connect)" }).handle(finish),
    oidcLogout: route.post(`${base}/logout`, { auth: "public", summary: "Sign out of the app and at the identity provider (OpenID Connect)" }).handle(logout),
    loginPath: `${base}/login`,
    logoutPath: `${base}/logout`,
  };
}
