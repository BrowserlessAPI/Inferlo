import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = "https://app.example.com";

test("Auth.js sessions sign users in to the app's routes, and its endpoints are served by the app", async () => {
  const { app } = await import("../src/app.ts");
  const send = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    app.fetch(new Request(BASE + path, { method: init.method ?? "GET", headers: init.headers, body: init.body }));
  const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);
  async function signIn(email: string): Promise<string> {
    const csrf = await send("/auth/csrf");
    assert.equal(csrf.status, 200, "the app serves Auth.js's endpoints under /auth");
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const res = await send("/auth/callback/credentials", {
      method: "POST",
      headers: { cookie: cookiesOf(csrf).join("; "), "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ csrfToken, email, password: "correct horse" }).toString(),
    });
    assert.equal(res.status, 302);
    return cookiesOf(res).filter((c) => c.includes("session-token")).join("; ");
  }

  assert.equal((await send("/notes")).status, 401, "routes stay private");
  const ada = await signIn("ada@example.com");
  const created = await send("/notes", { method: "POST", headers: { cookie: ada, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ title: "From the browser" }) });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { ownerId: string }).ownerId, "user-ada", "the note belongs to the Auth.js user");
  const list = (await (await send("/notes", { headers: { cookie: ada } })).json()) as { title: string }[];
  assert.deepEqual(list.map((n) => n.title), ["From the browser"]);
  const bob = await signIn("bob@example.com");
  assert.deepEqual(await (await send("/notes", { headers: { cookie: bob } })).json(), [], "users see only their own notes");

  const crossSite = await send("/notes", { method: "POST", headers: { cookie: ada, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify({ title: "Spam" }) });
  assert.equal(crossSite.status, 403, "other sites cannot change data with the cookie");
});
