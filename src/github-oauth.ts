/**
 * Sign in with GitHub for browser apps: the OAuth authorization code flow with state and PKCE, ending in a
 * sessions() cookie. GitHub is not an OpenID Connect provider, so oidc() cannot be used for it; Google, Microsoft
 * Entra ID, Okta and the others use oidc().
 *
 *   export const github = githubOAuth({
 *     clientId: settings.GITHUB_CLIENT_ID,
 *     clientSecret: settings.GITHUB_CLIENT_SECRET,
 *     session,
 *     userId: async (profile, { db }) => (await db.users.findOne({ githubId: profile.id }))?.id ?? null,
 *   });
 *   createApp({ auth: session, routes: [notes, github] });
 *
 * GET /auth/github/login (?returnTo=/path) sends the browser to GitHub; GET /auth/github/callback checks the state,
 * exchanges the code with the client secret and the PKCE verifier, loads the user's profile and verified emails,
 * asks userId(profile) which user signs in, starts the session and sends the browser back. GitHub Enterprise Server
 * works with url. No runtime dependencies.
 */
import { safeEqual } from "./auth.ts";
import { InferloError } from "./errors.ts";
import { isLocal } from "./jwt.ts";
import { base64url, cookieFor, random, readCookie, safeReturnTo } from "./oidc.ts";
import { route, type AppDb, type RouteDef } from "./route.ts";
import type { Sessions } from "./sessions.ts";

/** The signed-in GitHub account. */
export interface GitHubProfile {
  /** GitHub's numeric user id. It never changes: match users on it (logins can be renamed). */
  id: number;
  /** The login (username), such as "octocat". */
  login: string;
  name: string | null;
  /** The account's primary email when GitHub has verified it, otherwise null. */
  email: string | null;
  /** Every email address of the account that GitHub has verified (needs the user:email scope, which is the default). */
  verifiedEmails: string[];
  avatarUrl: string | null;
  /** The account's profile as GitHub's API returned it (GET /user). */
  raw: Record<string, unknown>;
}

/** GitHub's answer to the code exchange. */
export interface GitHubTokens {
  /** For calling GitHub's API as the user; never stored by Inferlo. */
  accessToken: string;
  /** The scopes the user granted, as GitHub reports them ("read:user,user:email"). */
  scope: string;
  /** GitHub Apps with expiring tokens also send these. */
  refreshToken?: string;
  expiresIn?: number;
}

export interface GitHubOAuthOptions {
  /** The client id of the OAuth app or GitHub App. */
  clientId: string;
  /** Its client secret (keep it in config({ secrets })). */
  clientSecret: string;
  /** The sessions() the sign-in ends in; also the app's auth: createApp({ auth: session }). */
  session: Sessions;
  /**
   * The id of the app's user for a GitHub account (find or create the user), or null to refuse the sign-in
   * (403 IL3011). Match users on profile.id, or on profile.email (verified by GitHub) when it is not null.
   */
  userId: (profile: GitHubProfile, ctx: { db: AppDb; req: Request; tokens: GitHubTokens }) => string | null | undefined | Promise<string | null | undefined>;
  /** Scopes to ask for. Default ["read:user", "user:email"]. */
  scopes?: string[];
  /** Where GitHub sends the browser back, registered as the app's callback URL. Default: <the request's origin><basePath>/callback. */
  redirectUri?: string;
  /** Where the login and callback routes are. Default "/auth/github". */
  basePath?: string;
  /** GitHub Enterprise Server's address, such as "https://github.acme.com" (its API is <url>/api/v3). Default https://github.com. */
  url?: string;
  /** Show GitHub's sign-up option to people without an account (default true, as GitHub does). */
  allowSignup?: boolean;
}

/** routes: [github] adds the two routes. */
export type GitHubOAuth = {
  /** GET <basePath>/login?returnTo=/path: sends the browser to GitHub. */
  githubLogin: RouteDef;
  /** GET <basePath>/callback: the callback URL registered at GitHub. */
  githubCallback: RouteDef;
  /** The login route's path, for links: <a href={github.loginPath}>. */
  loginPath: string;
};

interface Pending {
  /** state */
  s: string;
  /** PKCE code verifier */
  v: string;
  /** returnTo */
  r: string;
  /** expires (ms since 1970) */
  e: number;
}

const OPTIONS = ["clientId", "clientSecret", "session", "userId", "scopes", "redirectUri", "basePath", "url", "allowSignup"];
const FETCH_TIMEOUT = 5000;
const PENDING_MS = 600_000;
const fix =
  "Use githubOAuth({ clientId: settings.GITHUB_CLIENT_ID, clientSecret: settings.GITHUB_CLIENT_SECRET, session, userId: (profile, { db }) => ... }) with the client id and secret of the OAuth app (GitHub: Settings, Developer settings, OAuth Apps).";

function invalid(message: string, fixText = fix): InferloError {
  return new InferloError("IL6067", message, { fix: fixText });
}

function failed(reason: string): InferloError {
  return new InferloError("IL3009", `The sign-in could not be completed: ${reason}.`, {
    status: 400,
    fix: "Start the sign-in again from the app's login link, in the same browser. If it keeps failing, check the OAuth app's callback URL at GitHub.",
  });
}

function unreachable(what: string, cause: unknown): InferloError {
  return new InferloError("IL3010", `GitHub could not be used: ${what}.`, {
    status: 502,
    fix: `Check the client id, client secret and callback URL of the OAuth app, and that GitHub is reachable from the server (${cause instanceof Error ? cause.message : String(cause)}).`,
  });
}

function checkedUrl(value: unknown, what: string): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw invalid(`githubOAuth() ${what} must be a URL, got ${JSON.stringify(value)}.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal(url))) {
    throw invalid(`githubOAuth() ${what} must use https (plain http only on localhost), got ${JSON.stringify(value)}.`);
  }
  return url;
}

/**
 * Sign in with GitHub for browser apps: routes: [github] with github = githubOAuth({ clientId, clientSecret,
 * session, userId }). The sign-in ends in the session's cookie.
 */
export function githubOAuth(options: GitHubOAuthOptions): GitHubOAuth {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw invalid("githubOAuth() needs { clientId, clientSecret, session, userId }.");
  for (const key of Object.keys(options)) if (!OPTIONS.includes(key)) throw invalid(`githubOAuth() has no option "${key}".`, `Use ${OPTIONS.join(", ")}.`);
  if (typeof options.clientId !== "string" || !options.clientId) throw invalid("githubOAuth() needs the clientId of the OAuth app.");
  if (typeof options.clientSecret !== "string" || !options.clientSecret) {
    throw invalid("githubOAuth() needs the clientSecret of the OAuth app.", "Keep the client secret in config({ secrets }) and pass it as clientSecret.");
  }
  const session = options.session;
  if (!session || typeof session !== "object" || typeof session.signIn !== "function" || typeof session.resolve !== "function") {
    throw invalid("githubOAuth() needs session: the sessions() the sign-in ends in.", "Pass session = sessions({ secret, user }), and use it as the app's auth too: createApp({ auth: session }).");
  }
  if (typeof options.userId !== "function") throw invalid("githubOAuth() needs userId(profile, { db }): the id of the app's user for a GitHub account, or null to refuse it.");
  const scopes = options.scopes ?? ["read:user", "user:email"];
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string" || !/^[a-z:_]{1,64}$/.test(s))) {
    throw invalid('githubOAuth() scopes must be a list of GitHub scope names, such as ["read:user", "user:email"].');
  }
  const redirectUri = options.redirectUri === undefined ? undefined : checkedUrl(options.redirectUri, "redirectUri").href;
  const basePath = options.basePath ?? "/auth/github";
  if (typeof basePath !== "string" || !/^\/[A-Za-z0-9._~\-/]*$/.test(basePath) || basePath.includes("//") || !basePath.replace(/\/+$/, "")) {
    throw invalid(`githubOAuth() basePath must be a path such as "/auth/github", got ${JSON.stringify(basePath)}.`);
  }
  if (options.allowSignup !== undefined && typeof options.allowSignup !== "boolean") throw invalid("githubOAuth() allowSignup must be true or false.");
  const site = options.url === undefined ? new URL("https://github.com") : checkedUrl(options.url, "url");
  const web = site.origin;
  // github.com's API has its own host; GitHub Enterprise Server serves it under /api/v3.
  const api = web === "https://github.com" ? "https://api.github.com" : `${web}/api/v3`;
  const base = basePath.replace(/\/+$/, "");
  const { clientId, clientSecret } = options;
  const scope = [...new Set(scopes)].join(" ");

  const callbackUrl = (url: URL) => redirectUri ?? new URL(`${base}/callback`, url).href;

  const start = async (ctx: { url: URL; header(name: string, value: string): void }): Promise<Response> => {
    const pending: Pending = { s: random(), v: random(), r: safeReturnTo(ctx.url.searchParams.get("returnTo")), e: Date.now() + PENDING_MS };
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.v))));
    const target = new URL(`${web}/login/oauth/authorize`);
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("redirect_uri", callbackUrl(ctx.url));
    target.searchParams.set("scope", scope);
    target.searchParams.set("state", pending.s);
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    if (options.allowSignup === false) target.searchParams.set("allow_signup", "false");
    const login = ctx.url.searchParams.get("loginHint");
    if (login && /^[A-Za-z0-9-]{1,39}$/.test(login)) target.searchParams.set("login", login);
    const cookie = cookieFor(ctx.url, "inferlo_github");
    ctx.header("set-cookie", `${cookie.name}=${base64url(new TextEncoder().encode(JSON.stringify(pending)))}; ${cookie.attributes}; Max-Age=${PENDING_MS / 1000}`);
    ctx.header("cache-control", "no-store");
    return new Response(null, { status: 302, headers: { location: target.href } });
  };

  const exchange = async (code: string, verifier: string, url: URL): Promise<GitHubTokens> => {
    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl(url), code_verifier: verifier });
    let response: Response;
    let body: Record<string, unknown>;
    try {
      response = await fetch(`${web}/login/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      body = ((await response.json()) as Record<string, unknown> | null) ?? {};
    } catch (error) {
      throw unreachable("its token endpoint did not answer", error);
    }
    // GitHub answers errors with status 200 and an error field.
    if (!response.ok || typeof body.error === "string" || typeof body.access_token !== "string") {
      const error = typeof body.error === "string" && /^[\w.-]{1,64}$/.test(body.error) ? body.error : `status ${response.status}`;
      // A wrong client id, secret or callback URL is the app's configuration; anything else (a used or expired code) is this sign-in.
      if (error === "incorrect_client_credentials" || error === "redirect_uri_mismatch" || error === "unverified_user_email" || response.status >= 500) {
        throw unreachable(`it refused the code exchange (${error})`, error);
      }
      throw failed(`GitHub refused the code (${error})`);
    }
    const tokens: GitHubTokens = { accessToken: body.access_token as string, scope: typeof body.scope === "string" ? body.scope : "" };
    if (typeof body.refresh_token === "string") tokens.refreshToken = body.refresh_token;
    if (typeof body.expires_in === "number") tokens.expiresIn = body.expires_in;
    return tokens;
  };

  const apiGet = async (path: string, token: string, optional = false): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${api}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Inferlo" },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
    } catch (error) {
      throw unreachable(`its API did not answer (${path})`, error);
    }
    // /user/emails needs the user:email scope; without it the profile is still enough.
    if (optional && (response.status === 403 || response.status === 404)) return undefined;
    if (!response.ok) throw unreachable(`its API answered ${response.status} for ${path}`, `status ${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      throw unreachable(`its API did not answer JSON for ${path}`, error);
    }
  };

  const profileOf = async (token: string): Promise<GitHubProfile> => {
    const user = (await apiGet("/user", token)) as Record<string, unknown> | null;
    if (!user || typeof user !== "object" || typeof user.id !== "number" || typeof user.login !== "string") throw unreachable("its API answered no user for the token", "GET /user");
    const emails = await apiGet("/user/emails", token, true);
    const verified = Array.isArray(emails)
      ? emails.filter((e): e is { email: string; primary?: boolean; verified: true } => !!e && typeof e === "object" && typeof e.email === "string" && e.verified === true)
      : [];
    const primary = verified.find((e) => e.primary === true);
    return {
      id: user.id,
      login: user.login,
      name: typeof user.name === "string" ? user.name : null,
      email: primary?.email ?? null,
      verifiedEmails: verified.map((e) => e.email),
      avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null,
      raw: user,
    };
  };

  const finish = async (ctx: { url: URL; req: Request; db: AppDb; header(name: string, value: string): void }): Promise<Response> => {
    const params = ctx.url.searchParams;
    const cookie = cookieFor(ctx.url, "inferlo_github");
    // The pending sign-in is used once, whatever happens.
    ctx.header("set-cookie", `${cookie.name}=; ${cookie.attributes}; Max-Age=0`);
    ctx.header("cache-control", "no-store");
    let pending: Pending | undefined;
    try {
      const raw = readCookie(ctx.req.headers.get("cookie"), cookie.name);
      if (raw && raw.length < 4096) {
        const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as Pending;
        if (["s", "v", "r"].every((k) => typeof parsed[k as keyof Pending] === "string") && typeof parsed.e === "number") pending = parsed;
      }
    } catch {
      pending = undefined;
    }
    if (!pending || pending.e <= Date.now()) throw failed("it expired or was started in another browser");
    const state = params.get("state");
    if (!state || !safeEqual(state, pending.s)) throw failed("the state does not match the sign-in this browser started");
    const error = params.get("error");
    if (error !== null) throw failed(`GitHub answered ${/^[\w.-]{1,64}$/.test(error) ? error : "an error"}`);
    const code = params.get("code");
    if (!code) throw failed("GitHub sent no code");

    const tokens = await exchange(code, pending.v, ctx.url);
    const profile = await profileOf(tokens.accessToken);
    const userId = await options.userId(profile, { db: ctx.db, req: ctx.req, tokens });
    if (userId === null || userId === undefined) {
      throw new InferloError("IL3011", "This account may not sign in to the app.", { status: 403, fix: "Ask an administrator of the app for access." });
    }
    if (typeof userId !== "string" || !userId) {
      throw new InferloError("IL6067", "githubOAuth() userId must return the user's id as a non-empty string, or null to refuse the sign-in.", {
        fix: "Return the id of the app's user: userId: async (profile, { db }) => (await db.users.findOne({ githubId: profile.id }))?.id ?? null.",
      });
    }
    await session.signIn(ctx, userId);
    return new Response(null, { status: 302, headers: { location: pending.r } });
  };

  return {
    githubLogin: route.get(`${base}/login`, { auth: "public", summary: "Sign in with GitHub" }).handle(start),
    githubCallback: route.get(`${base}/callback`, { auth: "public", summary: "Finish the sign-in with GitHub" }).handle(finish),
    loginPath: `${base}/login`,
  };
}
