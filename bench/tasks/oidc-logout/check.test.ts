import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

const b64url = (bytes: Uint8Array | string) =>
  btoa(String.fromCharCode(...(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("sign-in shows the acme.com account picker and sign-out ends the session at the provider", async () => {
  // A local OpenID provider that signs in `next` and checks the client and the PKCE verifier.
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", use: "sig", alg: "RS256", key_ops: undefined };
  const codes = new Map<string, { challenge: string; nonce: string; claims: Record<string, unknown> }>();
  let next: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/.well-known/openid-configuration") return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout` });
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const basic = req.headers.authorization?.startsWith("Basic ") ? atob(req.headers.authorization.slice(6)).split(":")[1] : form.get("client_secret");
      if (basic !== "client-secret") return json(401, { error: "invalid_client" });
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const digest = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))));
      if (!grant || digest !== grant.challenge) return json(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1" }));
      const body = b64url(JSON.stringify({ iss: issuer, aud: "app-client", iat: now, exp: now + 300, nonce: grant.nonce, ...grant.claims }));
      const signature = b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`))));
      return json(200, { access_token: "at", token_type: "Bearer", id_token: `${head}.${body}.${signature}` });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SESSION_SECRET ??= "test-session-secret-that-is-long-enough-123";
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = "app-client";
  process.env.OIDC_CLIENT_SECRET = "client-secret";

  try {
    const { app } = await import("../src/app.ts");
    const db = app.db as any;
    const ada = await db.users.insert({ email: "ada@example.com", name: "Ada" });
    const BASE = "http://localhost:3000";

    async function signIn(claims: Record<string, unknown>): Promise<Response> {
      next = claims;
      const login = await app.fetch(new Request(`${BASE}/auth/login`));
      assert.equal(login.status, 302, "GET /auth/login sends the browser to the provider");
      const target = new URL(login.headers.get("location")!);
      assert.equal(target.origin, issuer);
      assert.equal(target.searchParams.get("code_challenge_method"), "S256", "PKCE");
      const code = b64url(crypto.getRandomValues(new Uint8Array(16)));
      codes.set(code, { challenge: target.searchParams.get("code_challenge")!, nonce: target.searchParams.get("nonce")!, claims: next });
      const back = new URL(target.searchParams.get("redirect_uri")!);
      assert.equal(back.pathname, "/auth/callback");
      back.searchParams.set("code", code);
      back.searchParams.set("state", target.searchParams.get("state")!);
      const pending = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      return app.fetch(new Request(back, { headers: { cookie: pending } }));
    }

    const ok = await signIn({ sub: "okta-1", email: "ada@example.com", email_verified: true });
    assert.equal(ok.status, 302);
    const cookie = ok.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c!.endsWith("=")).join("; ");
    assert.equal((await app.fetch(new Request(`${BASE}/notes`, { headers: { cookie } }))).status, 200, "the session cookie signs Ada in");

    const login = new URL((await app.fetch(new Request(`${BASE}/auth/login`))).headers.get("location")!).searchParams;
    assert.equal(login.get("prompt"), "select_account", "the account picker");
    assert.equal(login.get("hd"), "acme.com", "only acme.com accounts");

    const csrf = /_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
    let logout: Response | undefined;
    for (const path of ["/auth/logout", "/logout", "/session/logout"]) {
      const res = await app.fetch(new Request(`${BASE}${path}`, { method: "POST", headers: { cookie, "x-csrf-token": csrf } }));
      if (res.status !== 404) {
        logout = res;
        break;
      }
    }
    assert.ok(logout, "a sign-out route");
    assert.ok(logout.status === 302 || logout.status === 303, `sign-out redirects (${logout.status})`);
    const target = new URL(logout.headers.get("location")!);
    assert.equal(target.origin + target.pathname, `${issuer}/logout`, "to the provider's end_session_endpoint");
    assert.ok(target.searchParams.get("id_token_hint"), "with the ID token as id_token_hint");
    assert.equal(target.searchParams.get("post_logout_redirect_uri"), "https://app.acme.com/signed-out");
    assert.ok(logout.headers.getSetCookie().some((c) => /^inferlo_session=;/.test(c)), "the app's session ends");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
