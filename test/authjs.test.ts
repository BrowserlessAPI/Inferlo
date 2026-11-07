import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Auth } from "@auth/core";
import Credentials from "@auth/core/providers/credentials";
import { authJsSession } from "../src/authjs.ts";
import { createApp, InferloError, route, t } from "../src/index.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, error() {} };
const BASE = "http://app.test";

const people: Record<string, { id: string; name: string; roles: string[] }> = {
  "ada@example.com": { id: "user-ada", name: "Ada", roles: ["admin"] },
  "bob@example.com": { id: "user-bob", name: "Bob", roles: [] },
};

/** An Auth.js configuration with a password provider and JWT sessions that carry the user's id and roles. */
function makeConfig(extra: Record<string, unknown> = {}) {
  return {
    secret: "authjs-test-secret-0123456789abcdef0123456789abcdef",
    trustHost: true,
    providers: [
      Credentials({
        credentials: { email: {}, password: {} },
        authorize: async (input) => {
          const person = people[String(input.email)];
          return person && input.password === "correct horse" ? { id: person.id, email: String(input.email), name: person.name } : null;
        },
      }),
    ],
    callbacks: {
      jwt: ({ token, user }: { token: Record<string, unknown>; user?: { email?: string | null } }) => (user?.email ? { ...token, roles: people[user.email]?.roles ?? [] } : token),
      session: ({ session, token }: { session: { user: Record<string, unknown> }; token: Record<string, unknown> }) => ({ ...session, user: { ...session.user, id: token.sub, roles: token.roles } }),
    },
    logger: { error() {}, warn() {}, debug() {} },
    ...extra,
  };
}

const me = route.get("/me").handle(({ user }) => user);
const createNote = route.post("/notes", { body: t.object({ text: t.string().min(1) }) }).handle(({ body, user }) => ({ text: body.text, by: user.id }));
const adminOnly = route.get("/admin", { auth: "admin" }).handle(() => ({ ok: true }));
const open = route.get("/open", { auth: "public" }).handle(({ user }) => ({ signedIn: Boolean(user) }));

type Fetcher = { fetch(req: Request): Promise<Response> };
function call(app: Fetcher, pathname: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return app.fetch(new Request(BASE + pathname, init));
}
function cookiesOf(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]!);
}

/** Auth.js's sign-in: fetch the CSRF token, then post the credentials form through the app. */
async function signIn(app: Fetcher, email: string, basePath = "/auth"): Promise<string> {
  const csrf = await call(app, `${basePath}/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const res = await call(app, `${basePath}/callback/credentials`, {
    method: "POST",
    headers: { cookie: cookiesOf(csrf).join("; "), "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ csrfToken, email, password: "correct horse" }).toString(),
  });
  assert.equal(res.status, 302);
  const session = cookiesOf(res).filter((c) => c.includes("session-token"));
  assert.ok(session.length, "a session cookie");
  return session.join("; ");
}

describe("authJsSession()", () => {
  const config = makeConfig();
  const session = authJsSession(Auth, config);
  const app = createApp({ routes: [{ me, createNote, adminOnly, open }], auth: session, middleware: [session.middleware], logger: quiet });

  test("the middleware answers Auth.js's endpoints, and routes get the signed-in user", async () => {
    const cookie = await signIn(app, "ada@example.com");
    const res = await call(app, "/me", { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "user-ada", email: "ada@example.com", name: "Ada", roles: ["admin"] });
    assert.equal((await call(app, "/admin", { headers: { cookie } })).status, 200);
    const own = await call(app, "/auth/session", { headers: { cookie } });
    assert.equal(((await own.json()) as { user: { email: string } }).user.email, "ada@example.com");
    assert.ok(own.headers.get("x-request-id"), "Inferlo's headers apply to Auth.js's answers");
  });

  test("without a session, private routes answer 401 and public routes see no user", async () => {
    assert.equal((await call(app, "/me")).status, 401);
    assert.deepEqual(await (await call(app, "/open")).json(), { signedIn: false });
    assert.equal((await call(app, "/me", { headers: { cookie: "authjs.session-token=forged" } })).status, 401);
    const bob = await signIn(app, "bob@example.com");
    assert.equal((await call(app, "/admin", { headers: { cookie: bob } })).status, 403);
  });

  test("changes with the session cookie from another site are refused with IL3007", async () => {
    const cookie = await signIn(app, "bob@example.com");
    const post = (headers: Record<string, string>) => call(app, "/notes", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "hi" }) });
    const evil = await post({ origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    assert.equal(evil.status, 403);
    assert.equal(((await evil.json()) as { error: { code: string } }).error.code, "IL3007");
    assert.equal((await post({ origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ origin: BASE })).status, 200);
    assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 200);
    assert.equal((await post({})).status, 200, "clients that are not browsers");
  });

  test("sign-out ends the session for Inferlo routes too", async () => {
    const cookie = await signIn(app, "ada@example.com");
    const csrf = await call(app, "/auth/csrf", { headers: { cookie } });
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const out = await call(app, "/auth/signout", {
      method: "POST",
      headers: { cookie: [cookie, ...cookiesOf(csrf)].join("; "), "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ csrfToken }).toString(),
    });
    assert.equal(out.status, 302);
    const cleared = cookiesOf(out).filter((c) => c.includes("session-token"));
    assert.ok(cleared.every((c) => c.endsWith("=")), "the session cookie is cleared");
    assert.equal((await call(app, "/me", { headers: { cookie: cleared.join("; ") } })).status, 401);
  });
});

describe("authJsSession() options", () => {
  test("a session without a user id is a configuration error (IL6044) that names the fix", async () => {
    const config = makeConfig({ callbacks: {} });
    const session = authJsSession(Auth, config);
    const logged: string[] = [];
    const app = createApp({ routes: [{ me }], auth: session, middleware: [session.middleware], logger: { info() {}, error: (message: string) => void logged.push(message) } });
    const cookie = await signIn(app, "ada@example.com");
    const res = await call(app, "/me", { headers: { cookie } });
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL6044");
    assert.ok(logged.some((m) => m.includes("IL6044") && m.includes("callbacks")), "logged with the fix");
  });

  test("user maps the session, trustedOrigins and a custom basePath", async () => {
    const config = makeConfig({ basePath: "/api/auth" });
    const session = authJsSession(Auth, config, {
      user: (s) => (s.user?.email === "bob@example.com" ? null : { id: String(s.user?.id), roles: ["member"], expires: s.expires }),
      trustedOrigins: ["https://admin.app.test"],
    });
    assert.equal(session.basePath, "/api/auth");
    const app = createApp({ routes: [{ me, createNote }], auth: session, middleware: [session.middleware], logger: quiet });
    const cookie = await signIn(app, "ada@example.com", "/api/auth");
    const user = (await (await call(app, "/me", { headers: { cookie } })).json()) as { id: string; roles: string[]; expires: string };
    assert.equal(user.id, "user-ada");
    assert.deepEqual(user.roles, ["member"]);
    assert.equal(typeof user.expires, "string");
    const bob = await signIn(app, "bob@example.com", "/api/auth");
    assert.equal((await call(app, "/me", { headers: { cookie: bob } })).status, 401);
    const post = (origin: string) => call(app, "/notes", { method: "POST", headers: { cookie, origin, "sec-fetch-site": "same-site", "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    assert.equal((await post("https://admin.app.test")).status, 200);
    assert.equal((await post("https://other.app.test")).status, 403);
    assert.equal((await call(app, "/auth/session")).status, 404, "the default basePath is the app's");
  });

  test("invalid arguments raise IL6043", () => {
    const is6043 = (e: unknown) => e instanceof InferloError && e.code === "IL6043" && Boolean(e.fix);
    const config = makeConfig();
    assert.throws(() => authJsSession(undefined as never, config), is6043);
    assert.throws(() => authJsSession(config as never, Auth as never), is6043);
    assert.throws(() => authJsSession(Auth, { secret: "x" } as never), is6043);
    assert.throws(() => authJsSession(Auth, { ...config, basePath: "/" }), is6043);
    assert.throws(() => authJsSession(Auth, config, { users: () => null } as never), is6043);
    assert.throws(() => authJsSession(Auth, config, { user: "id" } as never), is6043);
    assert.throws(() => authJsSession(Auth, config, { trustedOrigins: "https://a.test" } as never), is6043);
    assert.throws(() => authJsSession(Auth, config, { trustedOrigins: ["https://a.test/x"] }), is6043);
    const plain = authJsSession(Auth, config, { roles: () => ["r"], tenant: () => "t" });
    assert.deepEqual(plain.roles?.({ id: "1" }), ["r"]);
    assert.equal(plain.tenant?.({ id: "1" }), "t");
  });
});

test("@browserlessapi/inferlo/authjs is exported and imports no Auth.js code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./authjs"], { types: "./dist/authjs.d.ts", default: "./dist/authjs.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "authjs.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./cross-site.ts", "./errors.ts"]);
});
