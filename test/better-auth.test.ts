import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, bearer } from "better-auth/plugins";
import { betterAuthSession } from "../src/better-auth.ts";
import { createApp, InferloError, route, t } from "../src/index.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, error() {}, warn() {} };
const BASE = "http://app.test";
const SECRET = "better-auth-test-secret-0123456789abcdef0123456789";

/** The in-memory tables of each Better Auth instance, to change a user directly in a test. */
const tables = new WeakMap<object, { user: Record<string, unknown>[] }>();

function makeAuth(extra: Record<string, unknown> = {}) {
  const db = { user: [] as Record<string, unknown>[], session: [], account: [], verification: [] };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: SECRET,
    baseURL: BASE,
    emailAndPassword: { enabled: true },
    plugins: [bearer(), admin()],
    telemetry: { enabled: false },
    logger: { disabled: true },
    ...extra,
  });
  tables.set(auth, db);
  return auth;
}

const me = route.get("/me").handle(({ user }) => user);
const createNote = route.post("/notes", { body: t.object({ text: t.string().min(1) }) }).handle(({ body, user }) => ({ text: body.text, by: user.id }));
const adminOnly = route.get("/admin/stats", { auth: "admin" }).handle(() => ({ ok: true }));
const open = route.get("/open", { auth: "public" }).handle(({ user }) => ({ signedIn: Boolean(user) }));

function call(app: { fetch(req: Request): Promise<Response> }, pathname: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return app.fetch(new Request(BASE + pathname, init));
}

async function signUp(app: { fetch(req: Request): Promise<Response> }, email: string) {
  const res = await call(app, "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: "correct horse battery", name: "Ada" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const token = res.headers.get("set-auth-token") ?? ((await res.json()) as { token: string }).token;
  return { cookie, token };
}

// One Better Auth instance for the tests that sign in: on Deno, a second instance's api.getSession can read the
// first instance's tables once both served requests in one process. Apps have one instance.
const auth = makeAuth({ trustedOrigins: ["https://admin.app.test"] });

describe("betterAuthSession()", () => {
  const session = betterAuthSession(auth);
  const app = createApp({ routes: [{ me, createNote, adminOnly, open }], auth: session, middleware: [session.middleware], logger: quiet });

  test("the middleware answers Better Auth's endpoints, and routes get the signed-in user", async () => {
    const { cookie } = await signUp(app, "ada@example.com");
    assert.match(cookie, /better-auth\.session_token=/);
    const res = await call(app, "/me", { headers: { cookie } });
    assert.equal(res.status, 200);
    const user = (await res.json()) as { id: string; email: string; name: string; roles: string[] };
    assert.equal(user.email, "ada@example.com");
    assert.equal(user.name, "Ada");
    assert.deepEqual(user.roles, ["user"]);
    assert.equal(typeof user.id, "string");
    // Better Auth's own session endpoint, through the middleware.
    const own = await call(app, "/api/auth/get-session", { headers: { cookie } });
    assert.equal(((await own.json()) as { user: { email: string } }).user.email, "ada@example.com");
    // Secure headers and the request id apply to Better Auth's answers too.
    assert.ok(own.headers.get("x-request-id"));
    assert.equal(own.headers.get("x-content-type-options"), "nosniff");
  });

  test("without a session, private routes answer 401 and public routes see no user", async () => {
    const res = await call(app, "/me");
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL3001");
    assert.deepEqual(await (await call(app, "/open")).json(), { signedIn: false });
    const forged = await call(app, "/me", { headers: { cookie: "better-auth.session_token=forged.value" } });
    assert.equal(forged.status, 401);
  });

  test("after sign-out the cookie no longer signs in", async () => {
    const { cookie } = await signUp(app, "signout@example.com");
    const out = await call(app, "/api/auth/sign-out", { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: "{}" });
    assert.equal(out.status, 200);
    assert.equal((await call(app, "/me", { headers: { cookie } })).status, 401);
  });

  test("changes with the session cookie from another site are refused with IL3007", async () => {
    const { cookie } = await signUp(app, "csrf@example.com");
    const post = (headers: Record<string, string>) =>
      call(app, "/notes", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "hi" }) });

    const evil = await post({ origin: "https://evil.example" });
    assert.equal(evil.status, 403);
    const body = (await evil.json()) as { error: { code: string } };
    assert.equal(body.error.code, "IL3007");
    assert.equal((await post({ "sec-fetch-site": "cross-site", origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "same-site", origin: "https://sub.app.test" })).status, 403);
    assert.equal((await post({ origin: "null" })).status, 403);

    // The app's own pages, browsers that mark the request same-origin, and clients that are not browsers.
    assert.equal((await post({ origin: BASE })).status, 200);
    assert.equal((await post({ "sec-fetch-site": "same-origin", origin: BASE })).status, 200);
    assert.equal((await post({})).status, 200);
    // Reading is allowed from anywhere (CORS decides what the other site may see).
    assert.equal((await call(app, "/me", { headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" } })).status, 200);
  });

  test("bearer tokens (Better Auth's bearer plugin) sign in without a cookie and are not origin-checked", async () => {
    const { token } = await signUp(app, "bearer@example.com");
    const res = await call(app, "/notes", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "https://other.example", "content-type": "application/json" },
      body: JSON.stringify({ text: "from a CLI" }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { text: string }).text, "from a CLI");
  });

  test("roles come from the admin plugin's user.role", async () => {
    const { cookie } = await signUp(app, "boss@example.com");
    assert.equal((await call(app, "/admin/stats", { headers: { cookie } })).status, 403);
    // As an admin would with the admin plugin's setRole; changed in Better Auth's table directly here.
    const row = tables.get(auth)!.user.find((u) => u.email === "boss@example.com")!;
    row.role = "admin,support";
    const res = await call(app, "/admin/stats", { headers: { cookie } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(((await (await call(app, "/me", { headers: { cookie } })).json()) as { roles: string[] }).roles, ["admin", "support"]);
  });
});

describe("betterAuthSession() options", () => {
  test("user maps the session to the app's user, and null refuses it", async () => {
    const session = betterAuthSession(auth, {
      user: ({ user, session: s }) => (user.email.startsWith("blocked") ? null : { id: user.id, email: user.email, sessionId: s.id, roles: ["member"] }),
    });
    const app = createApp({ routes: [{ me }], auth: session, middleware: [session.middleware], logger: quiet });
    const { cookie } = await signUp(app, "mapped@example.com");
    const user = (await (await call(app, "/me", { headers: { cookie } })).json()) as { sessionId: string; roles: string[] };
    assert.equal(typeof user.sessionId, "string");
    assert.deepEqual(user.roles, ["member"]);
    const blocked = await signUp(app, "blocked@example.com");
    assert.equal((await call(app, "/me", { headers: { cookie: blocked.cookie } })).status, 401);
  });

  test("trustedOrigins (and Better Auth's own) may change data with the cookie", async () => {
    const fromAuth = betterAuthSession(auth);
    const app = createApp({ routes: [{ createNote }], auth: fromAuth, middleware: [fromAuth.middleware], logger: quiet });
    const { cookie } = await signUp(app, "trusted@example.com");
    const post = (target: typeof app, origin: string) =>
      call(target, "/notes", { method: "POST", headers: { cookie, origin, "sec-fetch-site": "same-site", "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    assert.equal((await post(app, "https://admin.app.test")).status, 200);
    assert.equal((await post(app, "https://other.app.test")).status, 403);

    const own = betterAuthSession(auth, { trustedOrigins: ["https://other.app.test"] });
    const app2 = createApp({ routes: [{ createNote }], auth: own, middleware: [own.middleware], logger: quiet });
    assert.equal((await post(app2, "https://other.app.test")).status, 200);
    assert.equal((await post(app2, "https://admin.app.test")).status, 403, "the option replaces Better Auth's list");
  });

  test("a custom basePath is mounted, and other paths go on to the app", async () => {
    const auth = makeAuth({ basePath: "/auth" });
    const session = betterAuthSession(auth);
    assert.equal(session.basePath, "/auth");
    const fake = { handler: async () => new Response(), api: { getSession: async () => null }, options: { basePath: "/auth/" } };
    assert.equal(betterAuthSession(fake).basePath, "/auth", "a trailing slash is ignored");
    const app = createApp({ routes: [{ me, open }], auth: session, middleware: [session.middleware], logger: quiet });
    const res = await call(app, "/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "base@example.com", password: "correct horse battery", name: "B" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await call(app, "/open")).status, 200);
    assert.equal((await call(app, "/authors")).status, 404, "a path that only starts with the base path is the app's");
    assert.equal((await call(app, "/api/auth/get-session")).status, 404);
  });

  test("roles and tenant options are passed on", () => {
    const session = betterAuthSession(makeAuth(), { roles: () => ["x"], tenant: () => "t1" });
    assert.deepEqual(session.roles?.({ id: "1" }), ["x"]);
    assert.equal(session.tenant?.({ id: "1" }), "t1");
    const plain = betterAuthSession(makeAuth());
    assert.equal(plain.roles, undefined);
    assert.equal(plain.tenant, undefined);
  });

  test("invalid arguments raise IL6041", () => {
    const is6041 = (e: unknown) => e instanceof InferloError && e.code === "IL6041" && Boolean(e.fix);
    assert.throws(() => betterAuthSession(undefined as never), is6041);
    assert.throws(() => betterAuthSession({ handler() {} } as never), is6041);
    assert.throws(() => betterAuthSession(makeAuth(), { users: () => null } as never), is6041);
    assert.throws(() => betterAuthSession(makeAuth(), { user: "id" } as never), is6041);
    assert.throws(() => betterAuthSession(makeAuth(), { trustedOrigins: "https://a.test" } as never), is6041);
    assert.throws(() => betterAuthSession(makeAuth(), { trustedOrigins: ["https://a.test/path"] }), is6041);
    assert.throws(() => betterAuthSession(makeAuth(), { trustedOrigins: ["*.a.test"] }), is6041);
    assert.throws(() => betterAuthSession({ handler: async () => new Response(), api: { getSession: async () => null }, options: { basePath: "/" } }), is6041);
  });
});

test("@browserlessapi/inferlo/better-auth is exported and imports no Better Auth code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./better-auth"], { types: "./dist/better-auth.d.ts", default: "./dist/better-auth.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "better-auth.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./cross-site.ts", "./errors.ts"]);
});
