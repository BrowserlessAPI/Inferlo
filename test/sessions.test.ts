import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createApp, hashPassword, InferloError, model, route, sessions, t, verifyPassword } from "../src/index.ts";

const SECRET = "a-very-long-session-secret-for-tests-0123456789";
const users = new Map([
  ["u1", { id: "u1", email: "ada@example.com", roles: ["admin"], disabled: false }],
  ["u2", { id: "u2", email: "bob@example.com", roles: [] as string[], disabled: true }],
]);

function makeApp(options: Partial<Parameters<typeof sessions>[0]> = {}) {
  const session = sessions({ secret: SECRET, user: ({ userId }) => { const u = users.get(userId); return u && !u.disabled ? u : null; }, ...options });
  const routes = {
    login: route.post("/login", { auth: "public", body: t.object({ userId: t.string() }) }).handle(async (ctx) => {
      if (!users.has(ctx.body.userId)) return { ok: false };
      return session.signIn(ctx, ctx.body.userId);
    }),
    logout: route.post("/logout").handle((ctx) => {
      session.signOut(ctx);
      return { ok: true };
    }),
    me: route.get("/me").handle(({ user }) => ({ id: user.id })),
    admin: route.get("/admin", { auth: "admin" }).handle(() => ({ admin: true })),
    form: route.get("/form").handle(async ({ req }) => ({ csrf: await session.csrfToken(req) })),
    rename: route.post("/rename", { body: t.object({ name: t.string() }) }).handle(({ body, user }) => ({ name: body.name, by: user.id })),
    remove: route.delete("/things/:id").handle(({ params }) => ({ deleted: params.id })),
    raw: route.post("/raw", { auth: "public" }).handle(async (ctx) => {
      await session.signIn(ctx, "u1");
      return new Response("raw", { headers: { "set-cookie": "other=1; Path=/" } });
    }),
  };
  return { app: createApp({ name: "sessions-test", routes: [routes], auth: session }), session };
}

/** Signs in through the login route and returns the Cookie header value and the CSRF token. */
async function signIn(app: ReturnType<typeof makeApp>["app"], userId = "u1", base = "https://app.example.com") {
  const res = await app.fetch(new Request(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId }) }));
  assert.equal(res.status, 200);
  const setCookies = res.headers.getSetCookie();
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return { cookie, csrfToken, setCookies };
}

describe("sessions", () => {
  test("signIn sets a signed HttpOnly session cookie and a readable CSRF cookie, and the session signs the user in", async () => {
    const { app } = makeApp();
    const { cookie, csrfToken, setCookies } = await signIn(app);
    assert.equal(setCookies.length, 2);
    const [sessionCookie, csrfCookie] = setCookies;
    assert.match(sessionCookie!, /^inferlo_session=v1\.[\w-]+\.[\w-]+; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal(csrfCookie, `inferlo_session_csrf=${csrfToken}; Path=/; Max-Age=604800; Secure; SameSite=Lax`);
    const me = await app.fetch(new Request("https://app.example.com/me", { headers: { cookie } }));
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { id: "u1" });
    assert.equal((await app.fetch(new Request("https://app.example.com/admin", { headers: { cookie } }))).status, 200);
    assert.equal((await app.fetch(new Request("https://app.example.com/me"))).status, 401);
  });

  test("changes need the CSRF token in X-CSRF-Token or a _csrf form field (IL3005)", async () => {
    const { app } = makeApp();
    const { cookie, csrfToken } = await signIn(app);
    const post = (headers: Record<string, string>, body: string) => app.fetch(new Request("https://app.example.com/rename", { method: "POST", headers: { cookie, ...headers }, body }));
    const missing = await post({ "content-type": "application/json" }, JSON.stringify({ name: "x" }));
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error.code, "IL3005");
    const wrong = await post({ "content-type": "application/json", "x-csrf-token": csrfToken.slice(1) + "A" }, JSON.stringify({ name: "x" }));
    assert.equal(wrong.status, 403);
    const json = await post({ "content-type": "application/json", "x-csrf-token": csrfToken }, JSON.stringify({ name: "Lamp" }));
    assert.equal(json.status, 200);
    assert.deepEqual(await json.json(), { name: "Lamp", by: "u1" });
    // An HTML form: the route still reads the whole body, and the _csrf field is not part of it.
    const form = await post({ "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "Desk", _csrf: csrfToken }).toString());
    assert.equal(form.status, 200);
    assert.deepEqual(await form.json(), { name: "Desk", by: "u1" });
    const badForm = await post({ "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "Desk", _csrf: "nope" }).toString());
    assert.equal(badForm.status, 403);
    // Form bodies over 64 KiB are not searched for the token (send X-CSRF-Token instead).
    const big = await post({ "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams({ name: "x".repeat(70_000), _csrf: csrfToken }).toString());
    assert.equal(big.status, 403);
    const del = await app.fetch(new Request("https://app.example.com/things/7", { method: "DELETE", headers: { cookie } }));
    assert.equal(del.status, 403);
    const delOk = await app.fetch(new Request("https://app.example.com/things/7", { method: "DELETE", headers: { cookie, "x-csrf-token": csrfToken } }));
    assert.deepEqual(await delOk.json(), { deleted: "7" });
  });

  test("a CSRF token from another session does not work, and csrfToken(req) gives the session's token for forms", async () => {
    const { app } = makeApp();
    const a = await signIn(app);
    const b = await signIn(app);
    assert.notEqual(a.csrfToken, b.csrfToken);
    const res = await app.fetch(new Request("https://app.example.com/rename", { method: "POST", headers: { cookie: a.cookie, "x-csrf-token": b.csrfToken, "content-type": "application/json" }, body: "{\"name\":\"x\"}" }));
    assert.equal(res.status, 403);
    const form = await app.fetch(new Request("https://app.example.com/form", { headers: { cookie: a.cookie } }));
    assert.deepEqual(await form.json(), { csrf: a.csrfToken });
  });

  test("tampered, foreign, expired and unknown-user sessions are signed out", async () => {
    const { app } = makeApp();
    const { cookie } = await signIn(app);
    const value = cookie.split("; ")[0]!.split("=")[1]!;
    const [, payload, signature] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "u1", s: "x", i: Date.now(), e: Date.now() + 1e9 })).toString("base64url");
    for (const bad of [`v1.${forged}.${signature}`, `v1.${payload}.${signature!.slice(0, -2)}AA`, `v2.${payload}.${signature}`, "garbage", `v1.${payload}.${signature}.x`]) {
      assert.equal((await app.fetch(new Request("https://app.example.com/me", { headers: { cookie: `inferlo_session=${bad}` } }))).status, 401, bad);
    }
    const other = makeApp({ secret: "another-secret-that-is-at-least-32-characters" }).app;
    assert.equal((await other.fetch(new Request("https://app.example.com/me", { headers: { cookie } }))).status, 401);
    // u2 is disabled: user() returns null, so the session no longer signs anyone in.
    const disabled = await signIn(app, "u2");
    assert.equal((await app.fetch(new Request("https://app.example.com/me", { headers: { cookie: disabled.cookie } }))).status, 401);

    const realNow = Date.now;
    try {
      const { app: shortApp } = makeApp({ maxAgeMs: 60_000 });
      const short = await signIn(shortApp);
      assert.equal((await shortApp.fetch(new Request("https://app.example.com/me", { headers: { cookie: short.cookie } }))).status, 200);
      Date.now = () => realNow() + 61_000;
      assert.equal((await shortApp.fetch(new Request("https://app.example.com/me", { headers: { cookie: short.cookie } }))).status, 401);
    } finally {
      Date.now = realNow;
    }
  });

  test("user() gets the user id and issue time, so older sessions can be revoked", async () => {
    let seen: { userId: string; issuedAt: number } | undefined;
    const before = Date.now();
    const { app } = makeApp({ user: (data) => ((seen = data), users.get(data.userId)) });
    const { cookie } = await signIn(app);
    await app.fetch(new Request("https://app.example.com/me", { headers: { cookie } }));
    assert.equal(seen!.userId, "u1");
    assert.ok(seen!.issuedAt >= before && seen!.issuedAt <= Date.now());
  });

  test("secret rotation: sessions signed with an older secret stay valid, new ones use the first", async () => {
    const old = "old-secret-that-is-at-least-32-characters-long";
    const { app: oldApp } = makeApp({ secret: old });
    const { cookie, csrfToken } = await signIn(oldApp);
    const { app: rotated } = makeApp({ secret: [SECRET, old] });
    assert.equal((await rotated.fetch(new Request("https://app.example.com/me", { headers: { cookie } }))).status, 200);
    // The CSRF token is always derived with the newest secret, so the browser gets a fresh one at the next sign-in.
    const res = await rotated.fetch(new Request("https://app.example.com/form", { headers: { cookie } }));
    assert.notEqual((await res.json()).csrf, csrfToken);
    const fresh = await signIn(rotated);
    assert.equal((await makeApp().app.fetch(new Request("https://app.example.com/me", { headers: { cookie: fresh.cookie } }))).status, 200);
  });

  test("signOut clears both cookies", async () => {
    const { app } = makeApp();
    const { cookie, csrfToken } = await signIn(app);
    const res = await app.fetch(new Request("https://app.example.com/logout", { method: "POST", headers: { cookie, "x-csrf-token": csrfToken } }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.headers.getSetCookie(), [
      "inferlo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "inferlo_session_csrf=; Path=/; Max-Age=0; Secure; SameSite=Lax",
    ]);
  });

  test("cookie options, http on localhost without Secure, and cookies kept on a returned Response", async () => {
    const { app } = makeApp({ cookie: { name: "app_sid", sameSite: "strict", domain: "example.com", path: "/app" }, maxAgeMs: 3_600_000 });
    const { setCookies } = await signIn(app);
    assert.match(setCookies[0]!, /^app_sid=v1\.[^;]+; Path=\/app; Domain=example\.com; Max-Age=3600; HttpOnly; Secure; SameSite=Strict$/);
    assert.match(setCookies[1]!, /^app_sid_csrf=/);
    const local = await signIn(makeApp().app, "u1", "http://localhost:3000");
    assert.ok(local.setCookies.every((c) => !c.includes("Secure")));
    const forced = await signIn(makeApp({ cookie: { secure: true } }).app, "u1", "http://localhost:3000");
    assert.ok(forced.setCookies.every((c) => c.includes("; Secure")));
    const raw = await makeApp().app.fetch(new Request("https://app.example.com/raw", { method: "POST" }));
    assert.equal(await raw.text(), "raw");
    assert.deepEqual(raw.headers.getSetCookie().map((c) => c.split("=")[0]), ["other", "inferlo_session", "inferlo_session_csrf"]);
  });

  test("a login form posted by a signed-in browser without the token is refused, other cookies are ignored", async () => {
    const { app } = makeApp();
    const { cookie } = await signIn(app);
    const res = await app.fetch(new Request("https://app.example.com/login", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ userId: "u1" }) }));
    assert.equal(res.status, 403);
    const anon = await app.fetch(new Request("https://app.example.com/rename", { method: "POST", headers: { cookie: "theme=dark; other=1", "content-type": "application/json" }, body: "{\"name\":\"x\"}" }));
    assert.equal(anon.status, 401);
  });

  test("works with a users model, hashed passwords and the database", async () => {
    const User = model("users", { email: t.string(), passwordHash: t.string() });
    // Without Register, db is untyped here; in an app, db.users.find(userId) is typed.
    const session = sessions({ secret: SECRET, user: ({ userId }, { db }) => (db as any).users.find(userId) });
    const login = route.post("/login", { auth: "public", body: t.object({ email: t.string(), password: t.string() }) }).handle(async (ctx) => {
      const user = await (ctx.db as any).users.findOne({ email: ctx.body.email });
      if (!user || !(await verifyPassword(ctx.body.password, user.passwordHash))) return new Response(null, { status: 401 });
      return session.signIn(ctx, user.id);
    });
    const me = route.get("/me").handle(({ user }) => ({ email: (user as unknown as { email: string }).email }));
    const app = createApp({ models: [User], routes: [{ login, me }], auth: session });
    await app.db.users.insert({ email: "ada@example.com", passwordHash: await hashPassword("correct horse", 1000) });
    const bad = await app.fetch(new Request("https://x.test/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", password: "nope" }) }));
    assert.equal(bad.status, 401);
    const ok = await app.fetch(new Request("https://x.test/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", password: "correct horse" }) }));
    const cookie = ok.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    assert.deepEqual(await (await app.fetch(new Request("https://x.test/me", { headers: { cookie } }))).json(), { email: "ada@example.com" });
  });

  test("invalid options raise IL6029", async () => {
    const fails = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InferloError && e.code === "IL6029");
    const user = () => null;
    fails(() => sessions(undefined as never));
    fails(() => sessions({ secret: "short", user }));
    fails(() => sessions({ secret: [], user }));
    fails(() => sessions({ secret: [SECRET, "short"], user }));
    fails(() => sessions({ secret: SECRET } as never));
    fails(() => sessions({ secret: SECRET, user, maxAgeMs: 1000 }));
    fails(() => sessions({ secret: SECRET, user, maxAgeMs: 401 * 86_400_000 }));
    fails(() => sessions({ secret: SECRET, user, cookie: { name: "bad name" } }));
    fails(() => sessions({ secret: SECRET, user, cookie: { sameSite: "none" as never } }));
    fails(() => sessions({ secret: SECRET, user, cookie: { domain: "a.com; x" } }));
    const s = sessions({ secret: SECRET, user });
    await assert.rejects(s.signIn({ url: new URL("https://x.test"), header() {} }, ""), (e: unknown) => e instanceof InferloError && e.code === "IL6029");
    await assert.rejects(s.signIn({} as never, "u1"), (e: unknown) => e instanceof InferloError && e.code === "IL6029");
    fails(() => s.signOut({} as never));
  });

  test("CORS preflights allow the X-CSRF-Token header by default", async () => {
    const session = sessions({ secret: SECRET, user: () => null });
    const app = createApp({ routes: [{ me: route.get("/me").handle(() => 1) }], auth: session, cors: { origin: "https://app.example.com", credentials: true } });
    const res = await app.fetch(new Request("https://api.example.com/me", { method: "OPTIONS", headers: { origin: "https://app.example.com", "access-control-request-method": "POST" } }));
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /x-csrf-token/);
  });
});
