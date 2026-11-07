import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

test("Passport's signed-in user is the Inferlo app's user, and cross-site changes are refused", async () => {
  const { server } = await import("../src/express.ts");
  const http = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  try {
    async function logIn(username: string): Promise<string> {
      const res = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username, password: "correct horse" }) });
      assert.equal(res.status, 200);
      return res.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
    }
    const send = (path: string, cookie: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
      fetch(base + path, { method: init.method ?? "GET", headers: { cookie, ...init.headers }, body: init.body });

    assert.equal((await send("/api/notes", "")).status, 401, "routes stay private");
    const ada = await logIn("ada");
    const created = await send("/api/notes", ada, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "From the browser" }) });
    assert.equal(created.status, 201);
    assert.equal(((await created.json()) as { ownerId: string }).ownerId, "user-ada", "the note belongs to the Passport user");
    const list = (await (await send("/api/notes", ada)).json()) as { title: string }[];
    assert.deepEqual(list.map((n) => n.title), ["From the browser"]);
    const bob = await logIn("bob");
    assert.deepEqual(await (await send("/api/notes", bob)).json(), [], "users see only their own notes");

    const crossSite = await send("/api/notes", ada, { method: "POST", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify({ title: "Spam" }) });
    assert.equal(crossSite.status, 403, "other sites cannot change data with the session cookie");
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
