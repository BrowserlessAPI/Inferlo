import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = "https://app.example.com";

test("Better Auth's sessions sign users in to the app's routes, and its endpoints are served by the app", async () => {
  const { app } = await import("../src/app.ts");
  const send = (path: string, init: { method?: string; headers?: Record<string, string>; json?: unknown } = {}) =>
    app.fetch(
      new Request(BASE + path, {
        method: init.method ?? "GET",
        headers: { ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      }),
    );

  assert.equal((await send("/notes")).status, 401, "routes stay private");
  const signUp = await send("/api/auth/sign-up/email", { method: "POST", headers: { origin: BASE }, json: { email: "ada@example.com", password: "correct horse battery", name: "Ada" } });
  assert.equal(signUp.status, 200, "the app serves Better Auth's endpoints under /api/auth");
  const { user } = (await signUp.json()) as { user: { id: string } };
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const created = await send("/notes", { method: "POST", headers: { cookie, origin: BASE }, json: { title: "From the browser" } });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { ownerId: string }).ownerId, user.id, "the note belongs to the Better Auth user");
  const list = (await (await send("/notes", { headers: { cookie } })).json()) as { title: string }[];
  assert.deepEqual(list.map((n) => n.title), ["From the browser"]);

  const crossSite = await send("/notes", { method: "POST", headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" }, json: { title: "Spam" } });
  assert.equal(crossSite.status, 403, "other sites cannot change data with the cookie");

  const out = await send("/api/auth/sign-out", { method: "POST", headers: { cookie, origin: BASE }, json: {} });
  assert.equal(out.status, 200);
  assert.equal((await send("/notes", { headers: { cookie } })).status, 401, "signed out");
});
