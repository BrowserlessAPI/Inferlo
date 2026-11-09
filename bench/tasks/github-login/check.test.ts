import assert from "node:assert/strict";
import { test } from "node:test";

test("users sign in with GitHub and get the cookie session", async () => {
  process.env.SESSION_SECRET ??= "test-session-secret-that-is-long-enough-123";
  process.env.GITHUB_CLIENT_ID = "gh-client";
  process.env.GITHUB_CLIENT_SECRET = "gh-secret";
  // GitHub stand-in: the token endpoint checks the client and the PKCE verifier; the API answers the profile and emails.
  const codes = new Map<string, string>();
  let emails: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://github.com/login/oauth/access_token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("client_id") !== "gh-client" || form.get("client_secret") !== "gh-secret") return Response.json({ error: "incorrect_client_credentials" });
      const challenge = codes.get(form.get("code") ?? "");
      const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (!challenge || challenge !== digest) return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: "gho_x", token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id: 42, login: "ada", name: "Ada" });
    if (url === "https://api.github.com/user/emails") return Response.json(emails);
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const { app } = await import("../src/app.ts");
    const db = app.db as any;
    const ada = await db.users.insert({ email: "ada@example.com", name: "Ada" });
    const BASE = "http://localhost:3000";

    async function signIn(accountEmails: unknown[]): Promise<Response> {
      emails = accountEmails;
      const login = await app.fetch(new Request(`${BASE}/auth/github/login`));
      assert.equal(login.status, 302, "GET /auth/github/login sends the browser to GitHub");
      const target = new URL(login.headers.get("location")!);
      assert.equal(target.origin + target.pathname, "https://github.com/login/oauth/authorize");
      const code = crypto.randomUUID();
      codes.set(code, target.searchParams.get("code_challenge")!);
      const back = new URL(target.searchParams.get("redirect_uri")!);
      assert.equal(back.pathname, "/auth/github/callback");
      back.searchParams.set("code", code);
      back.searchParams.set("state", target.searchParams.get("state")!);
      const pending = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      return app.fetch(new Request(back, { headers: { cookie: pending } }));
    }

    const ok = await signIn([{ email: "ada@example.com", primary: true, verified: true }]);
    assert.equal(ok.status, 302);
    const cookie = ok.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c!.endsWith("=")).join("; ");
    const created = await app.fetch(new Request(`${BASE}/notes`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": /_csrf=([^;]+)/.exec(cookie)?.[1] ?? "" }, body: JSON.stringify({ title: "From GitHub" }) }));
    assert.equal(created.status, 201, "the session cookie signs Ada in");
    assert.equal(((await created.json()) as { ownerId: string }).ownerId, ada.id);

    assert.equal((await signIn([{ email: "ada@example.com", primary: true, verified: false }])).status, 403, "unverified emails are refused");
    assert.equal((await signIn([{ email: "mallory@example.com", primary: true, verified: true }])).status, 403, "unknown emails are refused");
  } finally {
    globalThis.fetch = realFetch;
  }
});
