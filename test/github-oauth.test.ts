import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { createApp, githubOAuth, InferloError, route, sessions, type GitHubOAuthOptions, type GitHubProfile } from "../src/index.ts";

const quiet = { info() {}, error() {} };
const APP = "http://localhost:3000";
const CLIENT_ID = "Iv1.inferlo";
const CLIENT_SECRET = "gh-secret/with+symbols";

/**
 * A local GitHub (as GitHub Enterprise Server serves it): an authorize page that approves `nextUser`, a token
 * endpoint that checks the client, the code, the callback URL and the PKCE verifier and answers errors with
 * status 200 like GitHub, and the /api/v3/user and /api/v3/user/emails endpoints.
 */
class FakeGitHub {
  server!: Server;
  url = "";
  nextUser: Record<string, unknown> = { id: 583231, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/u/583231" };
  emails: unknown = [
    { email: "octo@old.example", primary: false, verified: false },
    { email: "octocat@example.com", primary: true, verified: true },
    { email: "cat@example.com", primary: false, verified: true },
  ];
  codes = new Map<string, { redirectUri: string; challenge: string; used: boolean }>();
  tokenRequests: URLSearchParams[] = [];
  apiRequests: { path: string; headers: Record<string, string | string[] | undefined> }[] = [];
  tokenError: string | undefined;

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    this.server.closeAllConnections();
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      this.tokenRequests.push(form);
      if (this.tokenError) return json(200, { error: this.tokenError, error_description: "nope" });
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return json(200, { error: "incorrect_client_credentials" });
      const code = this.codes.get(form.get("code") ?? "");
      if (!code || code.used) return json(200, { error: "bad_verification_code" });
      code.used = true;
      if (form.get("redirect_uri") !== code.redirectUri) return json(200, { error: "redirect_uri_mismatch" });
      const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))).toString("base64url");
      if (challenge !== code.challenge) return json(200, { error: "bad_verification_code" });
      return json(200, { access_token: "gho_token123", token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url.pathname.startsWith("/api/v3/")) {
      this.apiRequests.push({ path: url.pathname, headers: req.headers });
      if (req.headers.authorization !== "Bearer gho_token123") return json(401, { message: "Bad credentials" });
      if (url.pathname === "/api/v3/user") return json(200, this.nextUser);
      if (url.pathname === "/api/v3/user/emails") return this.emails === undefined ? json(404, { message: "Not Found" }) : json(200, this.emails);
    }
    json(404, { message: "Not Found" });
  }

  /** The user approves the app at GitHub: returns the callback URL GitHub would send the browser to. */
  authorize(location: string, extra: Record<string, string> = {}): string {
    const url = new URL(location);
    assert.equal(url.origin + url.pathname, `${this.url}/login/oauth/authorize`);
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const code = crypto.randomUUID();
    this.codes.set(code, { redirectUri: url.searchParams.get("redirect_uri")!, challenge: url.searchParams.get("code_challenge")!, used: false });
    const back = new URL(url.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state")!);
    for (const [k, v] of Object.entries(extra)) back.searchParams.set(k, v);
    return back.href;
  }
}

const users = [{ id: "user-octo", githubId: 583231, email: "octocat@example.com", roles: [] as string[] }];
const session = sessions({ secret: "github-test-session-secret-0123456789abcdef", user: ({ userId }) => users.find((u) => u.id === userId) ?? null });
const me = route.get("/me").handle(({ user }) => user);

function cookies(res: Response): Map<string, string> {
  return new Map(res.headers.getSetCookie().map((c) => [c.slice(0, c.indexOf("=")), c]));
}
const cookieValue = (setCookie: string | undefined) => setCookie!.split(";")[0]!;

describe("githubOAuth()", () => {
  const github = new FakeGitHub();
  const seen: GitHubProfile[] = [];
  before(() => github.start());
  after(() => github.stop());
  beforeEach(() => {
    github.tokenError = undefined;
    github.nextUser = { id: 583231, login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/u/583231" };
    github.emails = [
      { email: "octo@old.example", primary: false, verified: false },
      { email: "octocat@example.com", primary: true, verified: true },
      { email: "cat@example.com", primary: false, verified: true },
    ];
    seen.length = 0;
  });

  function makeApp(options: Partial<GitHubOAuthOptions> = {}) {
    const gh = githubOAuth({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      session,
      url: github.url,
      userId: (profile) => {
        seen.push(profile);
        return users.find((u) => u.githubId === profile.id)?.id ?? null;
      },
      ...options,
    });
    return { gh, app: createApp({ auth: session, routes: [{ me }, gh], logger: quiet }) };
  }

  async function signIn(app: { fetch(r: Request): Promise<Response> }, loginPath = "/auth/github/login?returnTo=/notes", extra: Record<string, string> = {}) {
    const login = await app.fetch(new Request(APP + loginPath));
    assert.equal(login.status, 302);
    const pending = cookieValue(cookies(login).get("inferlo_github"));
    const back = github.authorize(login.headers.get("location")!, extra);
    const callback = await app.fetch(new Request(back, { headers: { cookie: pending } }));
    return { login, pending, back, callback };
  }

  test("the code flow with state and PKCE ends in a session cookie, with the profile and verified emails", async () => {
    const { app, gh } = makeApp();
    assert.equal(gh.loginPath, "/auth/github/login");
    const { login, callback } = await signIn(app);
    const target = new URL(login.headers.get("location")!);
    assert.equal(target.searchParams.get("redirect_uri"), `${APP}/auth/github/callback`);
    assert.equal(target.searchParams.get("scope"), "read:user user:email");
    assert.match(cookies(login).get("inferlo_github")!, /HttpOnly; SameSite=Lax; Max-Age=600/);
    assert.equal(callback.status, 302, await callback.clone().text());
    assert.equal(callback.headers.get("location"), "/notes");
    assert.equal(callback.headers.get("cache-control"), "no-store");
    assert.equal(seen[0]!.id, 583231);
    assert.equal(seen[0]!.login, "octocat");
    assert.equal(seen[0]!.email, "octocat@example.com");
    assert.deepEqual(seen[0]!.verifiedEmails, ["octocat@example.com", "cat@example.com"]);
    assert.equal(seen[0]!.avatarUrl, "https://avatars.example/u/583231");
    const form = github.tokenRequests.at(-1)!;
    assert.equal(form.get("redirect_uri"), `${APP}/auth/github/callback`);
    assert.ok(form.get("code_verifier"));
    const api = github.apiRequests.find((r) => r.path === "/api/v3/user")!;
    assert.equal(api.headers["user-agent"], "Inferlo");
    assert.equal(api.headers["x-github-api-version"], "2022-11-28");
    const res = await app.fetch(new Request(`${APP}/me`, { headers: { cookie: cookieValue(cookies(callback).get("inferlo_session")) } }));
    assert.equal((await res.json()).id, "user-octo");
  });

  test("a wrong state, a missing or reused pending cookie, and errors from GitHub are refused with IL3009", async () => {
    const { app } = makeApp();
    const used = await signIn(app);
    assert.equal(used.callback.status, 302);
    const again = await app.fetch(new Request(used.back, { headers: { cookie: used.pending } }));
    assert.equal(again.status, 400);
    assert.equal((await again.json()).error.code, "IL3009");
    const login = await app.fetch(new Request(`${APP}/auth/github/login`));
    const back = new URL(github.authorize(login.headers.get("location")!));
    const noCookie = await app.fetch(new Request(back));
    assert.equal((await noCookie.json()).error.code, "IL3009");
    back.searchParams.set("state", "forged");
    const forged = await app.fetch(new Request(back, { headers: { cookie: cookieValue(cookies(login).get("inferlo_github")) } }));
    assert.equal((await forged.json()).error.code, "IL3009");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const denied = await app.fetch(new Request(`${APP}/auth/github/callback?error=access_denied&state=${state}`, { headers: { cookie: cookieValue(cookies(login).get("inferlo_github")) } }));
    assert.equal(denied.status, 400);
    assert.match((await denied.json()).error.message, /access_denied/);
    for (const res of [again, noCookie, forged, denied]) assert.equal(cookies(res).has("inferlo_session"), false);
  });

  test("returnTo stays on the app; userId null is 403 IL3011; a refused code is IL3009; a wrong secret is IL3010", async () => {
    const { app } = makeApp();
    const evil = await signIn(app, "/auth/github/login?returnTo=//evil.example/x");
    assert.equal(evil.callback.headers.get("location"), "/");
    github.nextUser = { id: 1, login: "stranger", name: null };
    const refused = await signIn(app);
    assert.equal(refused.callback.status, 403);
    assert.equal((await refused.callback.json()).error.code, "IL3011");
    github.tokenError = "bad_verification_code";
    const bad = await signIn(app);
    assert.equal(bad.callback.status, 400);
    assert.equal((await bad.callback.json()).error.code, "IL3009");
    github.tokenError = undefined;
    const wrong = makeApp({ clientSecret: "wrong-secret" }).app;
    const config = await signIn(wrong);
    assert.equal(config.callback.status, 502);
    const body = await config.callback.json();
    assert.equal(body.error.code, "IL3010");
    assert.doesNotMatch(JSON.stringify(body), /wrong-secret/);
  });

  test("without the user:email scope the profile has no email; unverified primary emails are not used", async () => {
    github.emails = undefined;
    const { app } = makeApp({ scopes: ["read:user"] });
    const { login, callback } = await signIn(app);
    assert.equal(new URL(login.headers.get("location")!).searchParams.get("scope"), "read:user");
    assert.equal(callback.status, 302);
    assert.equal(seen[0]!.email, null);
    assert.deepEqual(seen[0]!.verifiedEmails, []);
    github.emails = [{ email: "octocat@example.com", primary: true, verified: false }];
    await signIn(app);
    assert.equal(seen[1]!.email, null);
  });

  test("basePath, redirectUri, allowSignup and a login hint", async () => {
    const { app, gh } = makeApp({ basePath: "/sso/github", redirectUri: "https://app.example.com/sso/github/callback", allowSignup: false });
    assert.equal(gh.loginPath, "/sso/github/login");
    const login = await app.fetch(new Request(`${APP}/sso/github/login?loginHint=octocat`));
    const target = new URL(login.headers.get("location")!);
    assert.equal(target.searchParams.get("redirect_uri"), "https://app.example.com/sso/github/callback");
    assert.equal(target.searchParams.get("allow_signup"), "false");
    assert.equal(target.searchParams.get("login"), "octocat");
    const bad = await app.fetch(new Request(`${APP}/sso/github/login?loginHint=${encodeURIComponent("a b/c")}`));
    assert.equal(new URL(bad.headers.get("location")!).searchParams.get("login"), null);
  });

  test("on github.com the API is api.github.com; on https the pending cookie is a __Host- cookie", async () => {
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_token123", scope: "read:user,user:email" });
      if (url === "https://api.github.com/user") return Response.json({ id: 583231, login: "octocat", name: "The Octocat" });
      if (url === "https://api.github.com/user/emails") return Response.json([{ email: "octocat@example.com", primary: true, verified: true }]);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const gh = githubOAuth({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, session, userId: (p) => users.find((u) => u.githubId === p.id)?.id ?? null });
      const app = createApp({ auth: session, routes: [gh], logger: quiet });
      const login = await app.fetch(new Request("https://app.example.com/auth/github/login"));
      const target = new URL(login.headers.get("location")!);
      assert.equal(target.origin + target.pathname, "https://github.com/login/oauth/authorize");
      const pending = cookies(login).get("__Host-inferlo_github")!;
      assert.match(pending, /Path=\/; HttpOnly; Secure; SameSite=Lax/);
      const back = new URL("https://app.example.com/auth/github/callback");
      back.searchParams.set("code", "c1");
      back.searchParams.set("state", target.searchParams.get("state")!);
      const callback = await app.fetch(new Request(back, { headers: { cookie: cookieValue(pending) } }));
      assert.equal(callback.status, 302);
      assert.deepEqual(calls, ["https://github.com/login/oauth/access_token", "https://api.github.com/user", "https://api.github.com/user/emails"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("invalid options raise IL6067", () => {
    const valid = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, session, userId: () => null };
    const invalid: Record<string, unknown>[] = [
      { ...valid, clientId: "" },
      { ...valid, clientSecret: undefined },
      { ...valid, session: undefined },
      { ...valid, userId: "user-1" },
      { ...valid, scopes: ["read user"] },
      { ...valid, basePath: "auth" },
      { ...valid, url: "http://github.acme.com" },
      { ...valid, redirectUri: "not a url" },
      { ...valid, allowSignup: "no" },
      { ...valid, issuer: "https://github.com" },
    ];
    for (const options of invalid) {
      assert.throws(() => githubOAuth(options as never), (e: unknown) => e instanceof InferloError && e.code === "IL6067", JSON.stringify(Object.keys(options)));
    }
  });
});
