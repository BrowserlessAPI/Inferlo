import assert from "node:assert/strict";
import { test } from "node:test";
import { createToken, hashPassword, hashToken } from "@browserlessapi/inferlo";

process.env.SESSION_SECRET ??= "test-session-secret-that-is-long-enough-123";

test("password sign-in starts a cookie session with CSRF protection, and API keys still work", async () => {
  const { app } = await import("../src/app.ts");
  const db = app.db as any;
  const user = await db.users.insert({ email: "ada@example.com", name: "Ada", passwordHash: await hashPassword("correct horse", 1000) });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`https://app.example.com${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  assert.equal((await post("/login", { email: "ada@example.com", password: "wrong" })).status, 401);
  const res = await post("/login", { email: "ada@example.com", password: "correct horse" });
  assert.equal(res.status, 200);
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  assert.equal(typeof csrfToken, "string");
  const setCookies = res.headers.getSetCookie();
  assert.ok(setCookies.some((c) => /HttpOnly/.test(c)), "an HttpOnly session cookie");
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

  const list = await app.fetch(new Request("https://app.example.com/notes", { headers: { cookie } }));
  assert.equal(list.status, 200, "the cookie signs the user in");
  assert.equal((await post("/notes", { title: "x" }, { cookie })).status, 403, "changes need the CSRF token");
  const created = await post("/notes", { title: "From the browser" }, { cookie, "x-csrf-token": csrfToken });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { ownerId: string }).ownerId, user.id);

  const token = createToken("live");
  await db.api_keys.insert({ userId: user.id, hash: await hashToken(token) });
  assert.equal((await app.fetch(new Request("https://app.example.com/notes", { headers: { authorization: `Bearer ${token}` } }))).status, 200, "API keys still work");

  const out = await post("/logout", {}, { cookie, "x-csrf-token": csrfToken });
  assert.equal(out.status, 204);
  assert.ok(out.headers.getSetCookie().some((c) => c.includes("Max-Age=0")), "logout clears the cookie");
});
