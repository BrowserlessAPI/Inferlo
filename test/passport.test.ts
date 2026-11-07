import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import { Passport, Strategy } from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { createApp, InferloError, route, t, toNodeHandler } from "../src/index.ts";
import { passportSession, type PassportSessionOptions } from "../src/passport.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { info() {}, error() {} };

interface Person {
  id: number | string;
  email: string;
  displayName: string;
  roles: string[];
  blocked?: boolean;
}
const people: Record<string, Person> = {
  ada: { id: 1, email: "ada@example.com", displayName: "Ada", roles: ["admin"] },
  bob: { id: "user-bob", email: "bob@example.com", displayName: "Bob", roles: [] },
  eve: { id: "user-eve", email: "eve@example.com", displayName: "Eve", roles: [], blocked: true },
  nobody: { id: "", email: "nobody@example.com", displayName: "No id", roles: [] },
};

/** A bearer strategy for API clients: Authorization: Token <name>, with no session. */
class TokenStrategy extends Strategy {
  override name = "token";
  authenticate(req: express.Request): void {
    const match = /^Token (\w+)$/.exec(req.headers.authorization ?? "");
    const person = match ? people[match[1]!] : undefined;
    if (person) this.success(person);
    else this.fail(401);
  }
}

const me = route.get("/me").handle(({ user }) => user);
const createNote = route.post("/notes", { body: t.object({ text: t.string().min(1) }) }).handle(({ body, user }) => ({ text: body.text, by: user.id }));
const adminOnly = route.get("/admin", { auth: "admin" }).handle(() => ({ ok: true }));
const open = route.get("/open", { auth: "public" }).handle(({ user }) => ({ signedIn: Boolean(user) }));

/** An Express server with express-session, Passport's local strategy and an Inferlo app under /api. */
function makeServer(options?: PassportSessionOptions<Person>) {
  const passport = new Passport();
  passport.use(new LocalStrategy({ usernameField: "name" }, (name, password, done) => done(null, password === "correct horse" ? (people[name] ?? false) : false)));
  passport.use(new TokenStrategy());
  passport.serializeUser<string>((user, done) => done(null, (user as Person).email));
  passport.deserializeUser<string>((email, done) => done(null, Object.values(people).find((p) => p.email === email) ?? false));
  const app = createApp({ routes: [{ me, createNote, adminOnly, open }], auth: passportSession(options), logger: quiet });
  const server = express();
  server.use(session({ secret: "passport-test-secret-0123456789", resave: false, saveUninitialized: false }));
  server.use(passport.session());
  server.post("/login", express.urlencoded({ extended: false }), passport.authenticate("local"), (_req, res) => void res.json({ ok: true }));
  server.post("/logout", (req, res, next) => req.logout((error) => (error ? next(error) : res.json({ ok: true }))));
  server.use("/token-api", passport.authenticate("token", { session: false }), toNodeHandler(app));
  server.use("/api", toNodeHandler(app));
  return { app, server };
}

async function listen(server: express.Express): Promise<{ base: string; close(): Promise<void> }> {
  const http = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const { port } = http.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

async function logIn(base: string, name: string): Promise<string> {
  const res = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name, password: "correct horse" }) });
  assert.equal(res.status, 200, `logged in as ${name}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("connect.sid="));
  assert.ok(cookie, "express-session's cookie");
  return cookie;
}

describe("passportSession()", () => {
  const { server } = makeServer();
  let running: Awaited<ReturnType<typeof listen>>;
  before(async () => void (running = await listen(server)));
  after(() => running.close());
  const get = (pathname: string, headers: Record<string, string> = {}) => fetch(running.base + pathname, { headers });

  test("routes get the user Passport put on req.user, with a numeric id as a string", async () => {
    const cookie = await logIn(running.base, "ada");
    const res = await get("/api/me", { cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "1", email: "ada@example.com", name: "Ada", roles: ["admin"] });
    assert.equal((await get("/api/admin", { cookie })).status, 200);
  });

  test("without a login, private routes answer 401 and public routes see no user", async () => {
    assert.equal((await get("/api/me")).status, 401);
    assert.deepEqual(await (await get("/api/open")).json(), { signedIn: false });
  });

  test("roles come from the Passport user", async () => {
    const cookie = await logIn(running.base, "bob");
    assert.equal((await get("/api/admin", { cookie })).status, 403);
    assert.deepEqual(await (await get("/api/open", { cookie })).json(), { signedIn: true });
  });

  test("changes with the session cookie from another site are refused with IL3007", async () => {
    const cookie = await logIn(running.base, "bob");
    const post = (headers: Record<string, string>) =>
      fetch(`${running.base}/api/notes`, { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "hi" }) });
    const cross = await post({ origin: "https://evil.test", "sec-fetch-site": "cross-site" });
    assert.equal(cross.status, 403);
    assert.equal(((await cross.json()) as { error: { code: string } }).error.code, "IL3007");
    assert.equal((await post({ origin: running.base, "sec-fetch-site": "same-origin" })).status, 200);
    assert.deepEqual(await (await post({})).json(), { text: "hi", by: "user-bob" }, "clients that are not browsers pass");
  });

  test("logging out ends the session for Inferlo routes too", async () => {
    const cookie = await logIn(running.base, "bob");
    assert.equal((await get("/api/me", { cookie })).status, 200);
    assert.equal((await fetch(`${running.base}/logout`, { method: "POST", headers: { cookie } })).status, 200);
    assert.equal((await get("/api/me", { cookie })).status, 401);
  });

  test("strategies without a session (session: false) sign the request in, without the cross-site check", async () => {
    const res = await fetch(`${running.base}/token-api/notes`, {
      method: "POST",
      headers: { authorization: "Token bob", origin: "https://evil.test", "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: JSON.stringify({ text: "from a script" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from a script", by: "user-bob" });
    assert.equal((await get("/token-api/me", { authorization: "Token nobody-known" })).status, 401, "Passport refused it before Inferlo");
  });

  test("a Passport user without an id is a configuration error (IL6046) that names the fix", async () => {
    const res = await get("/token-api/me", { authorization: "Token nobody" });
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL6046");
  });
});

describe("passportSession() options", () => {
  const { server } = makeServer({
    user: (person, { nodeRequest }) => (person.blocked ? null : { id: `u-${person.id}`, roles: ["member"], sessionLogin: nodeRequest.session?.passport?.user !== undefined }),
    trustedOrigins: ["https://admin.app.test"],
    roles: (user) => (user.roles as string[]).concat("staff"),
    tenant: () => "acme",
  });
  let running: Awaited<ReturnType<typeof listen>>;
  before(async () => void (running = await listen(server)));
  after(() => running.close());

  test("user maps Passport's user or refuses it, and trustedOrigins may change data", async () => {
    const cookie = await logIn(running.base, "ada");
    assert.deepEqual(await (await fetch(`${running.base}/api/me`, { headers: { cookie } })).json(), { id: "u-1", roles: ["member"], sessionLogin: true });
    const eve = await logIn(running.base, "eve");
    assert.equal((await fetch(`${running.base}/api/me`, { headers: { cookie: eve } })).status, 401);
    const post = (origin: string) =>
      fetch(`${running.base}/api/notes`, { method: "POST", headers: { cookie, origin, "sec-fetch-site": "same-site", "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    assert.equal((await post("https://admin.app.test")).status, 200);
    assert.equal((await post("https://other.app.test")).status, 403);
  });

  test("an app not mounted with toNodeHandler answers 500 IL6046 for private routes", async () => {
    const logged: string[] = [];
    const app = createApp({ routes: [{ me, open }], auth: passportSession(), logger: { info() {}, error: (message: string) => void logged.push(message) } });
    const res = await app.fetch(new Request("http://app.test/me"));
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL6046");
    assert.ok(logged.some((m) => m.includes("IL6046") && m.includes("toNodeHandler")), "logged with the fix");
  });

  test("invalid arguments raise IL6045", () => {
    const is6045 = (e: unknown) => e instanceof InferloError && e.code === "IL6045" && Boolean(e.fix);
    assert.throws(() => passportSession("x" as never), is6045);
    assert.throws(() => passportSession({ users: () => null } as never), is6045);
    assert.throws(() => passportSession({ user: "id" } as never), is6045);
    assert.throws(() => passportSession({ trustedOrigins: "https://a.test" } as never), is6045);
    assert.throws(() => passportSession({ trustedOrigins: ["https://a.test/x"] }), is6045);
    const plain = passportSession({ roles: () => ["r"], tenant: () => "t" });
    assert.deepEqual(plain.roles?.({ id: "1" }), ["r"]);
    assert.equal(plain.tenant?.({ id: "1" }), "t");
  });
});

test("@browserlessapi/inferlo/passport is exported and imports no Passport code", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.deepEqual(pkg.exports["./passport"], { types: "./dist/passport.d.ts", default: "./dist/passport.js" });
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  const imports = [...readFileSync(path.join(repo, "src", "passport.ts"), "utf8").matchAll(/^import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./client-ip.ts", "./cross-site.ts", "./errors.ts"]);
});
