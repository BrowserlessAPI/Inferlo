import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { createApp, InferloError, oidc, route, sessions, type OidcOptions } from "../src/index.ts";

const quiet = { info() {}, error() {} };
const APP = "http://localhost:3000";
const CLIENT_ID = "inferlo-app";
const CLIENT_SECRET = "s3cret value/with+symbols";

function b64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A local OpenID provider: OpenID configuration, key set, an authorization endpoint that signs in `nextUser`, and
 * a token endpoint that checks the client, the code, the redirect URI and the PKCE verifier like a real provider.
 */
class Provider {
  server!: Server;
  issuer = "";
  privateKey!: CryptoKey;
  jwk!: JsonWebKey;
  authMethods: string[] | undefined = undefined;
  endSession = true;
  nextUser: Record<string, unknown> = { sub: "okta-ada", email: "ada@example.com", email_verified: true, name: "Ada" };
  /** Changes to the next ID token's claims, to test the checks. */
  tamper: Record<string, unknown> = {};
  codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; nonce: string; used: boolean }>();
  tokenRequests: { authorization?: string; form: URLSearchParams }[] = [];
  down = false;

  async start() {
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    this.privateKey = pair.privateKey;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    delete jwk.key_ops;
    this.jwk = { ...jwk, kid: "key-1", use: "sig", alg: "RS256" } as JsonWebKey;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", this.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (this.down) return json(503, { error: "down" });
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        ...(this.authMethods ? { token_endpoint_auth_methods_supported: this.authMethods } : {}),
        ...(this.endSession ? { end_session_endpoint: `${this.issuer}/logout` } : {}),
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [this.jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      this.tokenRequests.push({ authorization: req.headers.authorization, form });
      let clientId = form.get("client_id");
      let secret = form.get("client_secret");
      if (req.headers.authorization?.startsWith("Basic ")) {
        const [id, pass] = atob(req.headers.authorization.slice(6)).split(":").map((p) => decodeURIComponent(p!.replace(/\+/g, " ")));
        clientId = id!;
        secret = pass!;
      }
      if (clientId !== CLIENT_ID || (secret !== null && secret !== CLIENT_SECRET)) return json(401, { error: "invalid_client" });
      const grant = this.codes.get(form.get("code") ?? "");
      if (!grant || grant.used || grant.clientId !== clientId || grant.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
      grant.used = true;
      const digest = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))));
      if (digest !== grant.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: this.issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: grant.nonce, ...this.nextUser, ...this.tamper };
      const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "key-1" }));
      const body = b64url(JSON.stringify(claims));
      const signature = b64url(new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, this.privateKey, new TextEncoder().encode(`${head}.${body}`))));
      return json(200, { access_token: "access-123", token_type: "Bearer", expires_in: 3600, id_token: `${head}.${body}.${signature}` });
    }
    json(404, { error: "not_found" });
  }

  /** The user consents at the authorization endpoint: the redirect back to the app with a code and the state. */
  authorize(location: string, extra: Record<string, string> = {}): string {
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, `${this.issuer}/authorize`);
    const p = url.searchParams;
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("code_challenge_method"), "S256");
    const code = b64url(crypto.getRandomValues(new Uint8Array(16)));
    this.codes.set(code, { clientId: p.get("client_id")!, redirectUri: p.get("redirect_uri")!, challenge: p.get("code_challenge")!, nonce: p.get("nonce")!, used: false });
    const back = new URL(p.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", p.get("state")!);
    for (const [k, v] of Object.entries(extra)) back.searchParams.set(k, v);
    return back.href;
  }
}

const users = new Map([["ada@example.com", { id: "user-ada", email: "ada@example.com", roles: ["admin"] }]]);
const session = sessions({ secret: "oidc-test-session-secret-0123456789abcdef", user: ({ userId }) => [...users.values()].find((u) => u.id === userId) ?? null });
const me = route.get("/me").handle(({ user }) => user);

function makeApp(provider: Provider, options: Partial<OidcOptions> = {}) {
  const sso = oidc({
    issuer: provider.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    session,
    userId: (claims) => (claims.email_verified && claims.email ? (users.get(claims.email)?.id ?? null) : null),
    ...options,
  });
  return { sso, app: createApp({ auth: session, routes: [{ me }, sso], logger: quiet }) };
}

function cookies(res: Response): Map<string, string> {
  return new Map(res.headers.getSetCookie().map((c) => [c.slice(0, c.indexOf("=")), c]));
}
function cookieValue(setCookie: string | undefined): string {
  return setCookie!.split(";")[0]!;
}

/** Browser steps: open the login link, consent at the provider, follow the redirect back to the callback. */
async function signIn(app: { fetch(r: Request): Promise<Response> }, provider: Provider, loginPath = "/auth/login", extra: Record<string, string> = {}) {
  const login = await app.fetch(new Request(APP + loginPath));
  assert.equal(login.status, 302);
  const pending = cookieValue(cookies(login).get("inferlo_oidc"));
  const back = provider.authorize(login.headers.get("location")!, extra);
  const callback = await app.fetch(new Request(back, { headers: { cookie: pending } }));
  return { login, pending, callback, back };
}

describe("oidc()", () => {
  const provider = new Provider();
  before(() => provider.start());
  after(() => provider.stop());
  beforeEach(() => {
    provider.tamper = {};
    provider.down = false;
    provider.authMethods = undefined;
    provider.endSession = true;
    provider.nextUser = { sub: "okta-ada", email: "ada@example.com", email_verified: true, name: "Ada" };
  });

  test("the code flow with PKCE, state and nonce ends in a session cookie", async () => {
    const { app } = makeApp(provider);
    const login = await app.fetch(new Request(`${APP}/auth/login?returnTo=/notes?tab=mine`));
    assert.equal(login.status, 302);
    const target = new URL(login.headers.get("location")!);
    const p = target.searchParams;
    assert.equal(p.get("client_id"), CLIENT_ID);
    assert.equal(p.get("redirect_uri"), `${APP}/auth/callback`);
    assert.equal(p.get("scope"), "openid email profile");
    assert.match(p.get("state")!, /^[\w-]{43}$/);
    assert.match(p.get("nonce")!, /^[\w-]{43}$/);
    assert.match(p.get("code_challenge")!, /^[\w-]{43}$/);
    const pendingCookie = cookies(login).get("inferlo_oidc")!;
    assert.match(pendingCookie, /HttpOnly/);
    assert.match(pendingCookie, /SameSite=Lax/);
    assert.match(pendingCookie, /Max-Age=600/);
    assert.ok(!pendingCookie.includes(p.get("code_challenge")!), "the verifier, not the challenge, is kept");

    const callback = await app.fetch(new Request(provider.authorize(login.headers.get("location")!), { headers: { cookie: cookieValue(pendingCookie) } }));
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/notes?tab=mine");
    assert.equal(callback.headers.get("cache-control"), "no-store");
    const set = cookies(callback);
    assert.match(set.get("inferlo_oidc")!, /Max-Age=0/, "the pending sign-in is cleared");
    const sessionCookie = cookieValue(set.get("inferlo_session"));
    const res = await app.fetch(new Request(`${APP}/me`, { headers: { cookie: sessionCookie } }));
    assert.deepEqual(await res.json(), { id: "user-ada", email: "ada@example.com", roles: ["admin"] });

    const exchange = provider.tokenRequests.at(-1)!;
    assert.match(exchange.authorization ?? "", /^Basic /, "client_secret_basic by default");
    assert.equal(exchange.form.get("client_secret"), null);
  });

  test("returnTo stays on the app", async () => {
    const { app } = makeApp(provider);
    for (const returnTo of ["//evil.example/x", "https://evil.example", "/\\evil.example", "notes"]) {
      const login = await app.fetch(new Request(`${APP}/auth/login?returnTo=${encodeURIComponent(returnTo)}`));
      const callback = await app.fetch(new Request(provider.authorize(login.headers.get("location")!), { headers: { cookie: cookieValue(cookies(login).get("inferlo_oidc")) } }));
      assert.equal(callback.headers.get("location"), "/", returnTo);
    }
  });

  test("a callback without the pending cookie, with another state or reused is refused with IL3009", async () => {
    const { app } = makeApp(provider);
    const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
    const login = await app.fetch(new Request(`${APP}/auth/login`));
    const back = provider.authorize(login.headers.get("location")!);
    const noCookie = await app.fetch(new Request(back));
    assert.equal(noCookie.status, 400);
    assert.equal(await code(noCookie), "IL3009");

    const other = await app.fetch(new Request(`${APP}/auth/login`));
    const wrongState = await app.fetch(new Request(back, { headers: { cookie: cookieValue(cookies(other).get("inferlo_oidc")) } }));
    assert.equal(wrongState.status, 400);
    assert.equal(cookies(wrongState).has("inferlo_session"), false);

    const used = await signIn(app, provider);
    assert.equal(used.callback.status, 302);
    const again = await app.fetch(new Request(used.back, { headers: { cookie: used.pending } }));
    assert.equal(again.status, 400, "a code works once");
    assert.equal(((await again.json()) as { error: { code: string } }).error.code, "IL3009");
  });

  test("ID tokens with another audience, nonce, issuer or an expired time are refused", async () => {
    const { app } = makeApp(provider);
    for (const tamper of [{ aud: "another-app" }, { nonce: "other" }, { iss: "https://evil.example" }, { exp: Math.floor(Date.now() / 1000) - 600 }, { aud: [CLIENT_ID, "other"], azp: "other" }]) {
      provider.tamper = tamper;
      const { callback } = await signIn(app, provider);
      assert.equal(callback.status, 400, JSON.stringify(tamper));
      assert.equal(((await callback.json()) as { error: { code: string } }).error.code, "IL3009");
      assert.equal(cookies(callback).has("inferlo_session"), false);
    }
  });

  test("errors from the provider, and an answer naming another issuer, are refused", async () => {
    const { app } = makeApp(provider);
    const login = await app.fetch(new Request(`${APP}/auth/login`));
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const denied = await app.fetch(new Request(`${APP}/auth/callback?error=access_denied&state=${state}`, { headers: { cookie: cookieValue(cookies(login).get("inferlo_oidc")) } }));
    assert.equal(denied.status, 400);
    assert.match(((await denied.json()) as { error: { message: string } }).error.message, /access_denied/);
    const { callback } = await signIn(app, provider, "/auth/login", { iss: "https://evil.example" });
    assert.equal(callback.status, 400);
  });

  test("userId returning null refuses the sign-in with 403 IL3011", async () => {
    provider.nextUser = { sub: "okta-mallory", email: "ada@example.com", email_verified: false };
    const { app } = makeApp(provider);
    const { callback } = await signIn(app, provider);
    assert.equal(callback.status, 403);
    assert.equal(((await callback.json()) as { error: { code: string } }).error.code, "IL3011");
    assert.equal(cookies(callback).has("inferlo_session"), false);
  });

  test("userId gets the claims and tokens, and a wrong client secret is a configuration error (502 IL3010)", async () => {
    let seen: { claims: Record<string, unknown>; accessToken?: string } | undefined;
    const { app } = makeApp(provider, {
      userId: (claims, { tokens }) => {
        seen = { claims, accessToken: tokens.accessToken };
        return "user-ada";
      },
    });
    assert.equal((await signIn(app, provider)).callback.status, 302);
    assert.equal(seen?.claims.sub, "okta-ada");
    assert.equal(seen?.accessToken, "access-123");

    const wrong = makeApp(provider, { clientSecret: "wrong" }).app;
    const { callback } = await signIn(wrong, provider);
    assert.equal(callback.status, 502);
    assert.equal(((await callback.json()) as { error: { code: string } }).error.code, "IL3010");
  });

  test("client_secret_post when the provider only takes it, and public clients send their client id", async () => {
    provider.authMethods = ["client_secret_post"];
    assert.equal((await signIn(makeApp(provider).app, provider)).callback.status, 302);
    let exchange = provider.tokenRequests.at(-1)!;
    assert.equal(exchange.authorization, undefined);
    assert.equal(exchange.form.get("client_secret"), CLIENT_SECRET);

    provider.authMethods = undefined;
    const { app } = makeApp(provider, { clientSecret: undefined });
    assert.equal((await signIn(app, provider)).callback.status, 302);
    exchange = provider.tokenRequests.at(-1)!;
    assert.equal(exchange.form.get("client_id"), CLIENT_ID);
    assert.equal(exchange.form.get("client_secret"), null);
  });

  test("redirectUri, scopes and basePath", async () => {
    const { app, sso } = makeApp(provider, { basePath: "/sso/okta", scopes: ["email", "groups"], redirectUri: "http://localhost:3000/sso/okta/callback" });
    assert.equal(sso.loginPath, "/sso/okta/login");
    const { login, callback } = await signIn(app, provider, "/sso/okta/login");
    const p = new URL(login.headers.get("location")!).searchParams;
    assert.equal(p.get("scope"), "openid email groups");
    assert.equal(p.get("redirect_uri"), "http://localhost:3000/sso/okta/callback");
    assert.equal(callback.status, 302);
    assert.equal((await app.fetch(new Request(`${APP}/auth/login`))).status, 404);
  });

  test("authorizationParams, ?loginHint= and ?prompt= reach the provider", async () => {
    const { app } = makeApp(provider, { authorizationParams: { hd: "example.com", domain_hint: "example.com", prompt: "select_account" } });
    let p = new URL((await app.fetch(new Request(`${APP}/auth/login`))).headers.get("location")!).searchParams;
    assert.equal(p.get("hd"), "example.com");
    assert.equal(p.get("domain_hint"), "example.com");
    assert.equal(p.get("prompt"), "select_account");
    assert.equal(p.get("login_hint"), null);

    p = new URL((await app.fetch(new Request(`${APP}/auth/login?loginHint=ada%40example.com&prompt=login`))).headers.get("location")!).searchParams;
    assert.equal(p.get("login_hint"), "ada@example.com");
    assert.equal(p.get("prompt"), "login", "the link's prompt wins over the default");

    p = new URL((await app.fetch(new Request(`${APP}/auth/login?prompt=evil&loginHint=${"x".repeat(300)}&nonce=mine`))).headers.get("location")!).searchParams;
    assert.equal(p.get("prompt"), "select_account", "unknown prompt values are ignored");
    assert.equal(p.get("login_hint"), null, "overlong hints are ignored");
    assert.notEqual(p.get("nonce"), "mine", "the query cannot set the flow's own parameters");
    assert.equal((await signIn(app, provider)).callback.status, 302);
  });

  test("POST /auth/logout ends the session and signs out at the provider with id_token_hint", async () => {
    const { app, sso } = makeApp(provider, { postLogoutRedirectUri: "http://localhost:3000/signed-out" });
    assert.equal(sso.logoutPath, "/auth/logout");
    const { callback } = await signIn(app, provider);
    const set = cookies(callback);
    const idCookie = set.get("inferlo_oidc_id")!;
    assert.match(idCookie, /HttpOnly/);
    assert.match(idCookie, /SameSite=Lax/);
    const idToken = cookieValue(idCookie).slice("inferlo_oidc_id=".length);
    assert.equal(idToken.split(".").length, 3);
    const sessionCookie = cookieValue(set.get("inferlo_session"));
    const csrf = cookieValue(set.get("inferlo_session_csrf")).slice("inferlo_session_csrf=".length);
    const cookie = `${sessionCookie}; inferlo_oidc_id=${idToken}`;

    const forged = await app.fetch(new Request(`${APP}/auth/logout`, { method: "POST", headers: { cookie } }));
    assert.equal(forged.status, 403, "another site cannot sign the user out");
    assert.equal(((await forged.json()) as { error: { code: string } }).error.code, "IL3005");

    const form = new URLSearchParams({ _csrf: csrf });
    const res = await app.fetch(new Request(`${APP}/auth/logout`, { method: "POST", body: form.toString(), headers: { cookie, "content-type": "application/x-www-form-urlencoded" } }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const target = new URL(res.headers.get("location")!);
    assert.equal(target.origin + target.pathname, `${provider.issuer}/logout`);
    assert.equal(target.searchParams.get("id_token_hint"), idToken);
    assert.equal(target.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(target.searchParams.get("post_logout_redirect_uri"), "http://localhost:3000/signed-out");
    const cleared = cookies(res);
    for (const name of ["inferlo_session", "inferlo_session_csrf", "inferlo_oidc_id"]) assert.match(cleared.get(name)!, /Max-Age=0/, name);
  });

  test("logout without a session, with another provider's ID token, or at a provider without end_session_endpoint", async () => {
    const { app } = makeApp(provider);
    let res = await app.fetch(new Request(`${APP}/auth/logout`, { method: "POST" }));
    assert.equal(res.status, 303);
    let target = new URL(res.headers.get("location")!);
    assert.equal(target.searchParams.get("id_token_hint"), null);
    assert.equal(target.searchParams.get("post_logout_redirect_uri"), `${APP}/`);

    const other = `${b64url(JSON.stringify({ alg: "RS256" }))}.${b64url(JSON.stringify({ iss: "https://other.example" }))}.sig`;
    res = await app.fetch(new Request(`${APP}/auth/logout`, { method: "POST", headers: { cookie: `inferlo_oidc_id=${other}` } }));
    target = new URL(res.headers.get("location")!);
    assert.equal(target.searchParams.get("id_token_hint"), null, "only this provider's ID token is sent to it");

    const plain = new Provider();
    await plain.start();
    plain.endSession = false;
    try {
      res = await makeApp(plain).app.fetch(new Request(`${APP}/auth/logout`, { method: "POST" }));
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), `${APP}/`);
      plain.down = true;
      res = await makeApp(plain).app.fetch(new Request(`${APP}/auth/logout`, { method: "POST" }));
      assert.equal(res.status, 303, "an unreachable provider does not stop the app's sign-out");
      assert.equal(res.headers.get("location"), `${APP}/`);
    } finally {
      await plain.stop();
    }
  });

  test("on https the pending cookie is a Secure __Host- cookie", async () => {
    const { app } = makeApp(provider);
    const login = await app.fetch(new Request("https://app.example.com/auth/login"));
    const pending = cookies(login).get("__Host-inferlo_oidc")!;
    assert.match(pending, /Secure/);
    assert.match(pending, /Path=\//);
    assert.doesNotMatch(pending, /Domain=/);
  });

  test("an unreachable provider answers 502 IL3010", async () => {
    const fresh = new Provider();
    await fresh.start();
    fresh.down = true;
    try {
      const { app } = makeApp(fresh);
      const res = await app.fetch(new Request(`${APP}/auth/login`));
      assert.equal(res.status, 502);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL3010");
    } finally {
      await fresh.stop();
    }
  });
});

test("invalid oidc() options raise IL6047", () => {
  const is6047 = (e: unknown) => e instanceof InferloError && e.code === "IL6047" && Boolean(e.fix);
  const base = { issuer: "https://login.example.com", clientId: "app", session, userId: () => null };
  assert.throws(() => oidc(undefined as never), is6047);
  assert.throws(() => oidc({ ...base, issuer: "http://login.example.com" }), is6047, "https only, except on localhost");
  assert.throws(() => oidc({ ...base, clientId: "" }), is6047);
  assert.throws(() => oidc({ ...base, clientSecret: "" }), is6047);
  assert.throws(() => oidc({ ...base, session: {} as never }), is6047);
  assert.throws(() => oidc({ ...base, userId: "id" as never }), is6047);
  assert.throws(() => oidc({ ...base, scopes: ["open id"] }), is6047);
  assert.throws(() => oidc({ ...base, basePath: "/" }), is6047);
  assert.throws(() => oidc({ ...base, basePath: "auth" }), is6047);
  assert.throws(() => oidc({ ...base, redirectUri: "http://app.example.com/cb" }), is6047);
  assert.throws(() => oidc({ ...base, audience: "x" } as never), is6047);
  assert.throws(() => oidc({ ...base, authorizationParams: { nonce: "fixed" } }), is6047, "the flow's own parameters");
  assert.throws(() => oidc({ ...base, authorizationParams: { redirect_uri: "https://evil.example" } }), is6047);
  assert.throws(() => oidc({ ...base, authorizationParams: { prompt: 1 as never } }), is6047);
  assert.throws(() => oidc({ ...base, authorizationParams: [] as never }), is6047);
  assert.throws(() => oidc({ ...base, postLogoutRedirectUri: "http://app.example.com/" }), is6047);
  const sso = oidc(base);
  assert.equal(sso.oidcLogin.path, "/auth/login");
  assert.equal(sso.oidcCallback.path, "/auth/callback");
  assert.equal(sso.oidcLogin.options.auth, "public");
  assert.equal(sso.oidcLogout.path, "/auth/logout");
  assert.equal(sso.oidcLogout.method, "POST");
});
