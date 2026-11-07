/**
 * oidc() against a real OpenID provider: oidc-provider (the certified OpenID Connect server for Node.js), with
 * its development login and consent pages, PKCE required and the iss parameter in the authorization response.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import Provider from "oidc-provider";
import { createApp, oidc, route, sessions } from "../src/index.ts";

const APP = "http://localhost:3000";
let server: Server;
let issuer = "";

before(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "localhost", () => resolve()));
  issuer = `http://localhost:${(server.address() as AddressInfo).port}`;
  const provider = new Provider(issuer, {
    clients: [{ client_id: "inferlo-app", client_secret: "provider-test-client-secret", redirect_uris: [`${APP}/auth/callback`], grant_types: ["authorization_code"], response_types: ["code"] }],
    findAccount: async (_ctx: unknown, sub: string) => ({ accountId: sub, claims: async () => ({ sub, email: `${sub}@example.com`, email_verified: true }) }),
    claims: { openid: ["sub"], email: ["email", "email_verified"] },
    pkce: { required: () => true },
    // Put the email scope's claims in the ID token, as most providers do, instead of only in the userinfo answer.
    conformIdTokenClaims: false,
    // Every lifetime as a number: Bun 1.3.0 does not pass oidc-provider's check of its default lifetime functions.
    ttl: { AccessToken: 3600, AuthorizationCode: 60, BackchannelAuthenticationRequest: 600, ClientCredentials: 600, DeviceCode: 600, Grant: 3600, IdToken: 3600, Interaction: 600, PreAuthorizedCode: 600, RefreshToken: 86400, Session: 3600 },
  });
  server.on("request", provider.callback());
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** A browser at the provider: follows redirects, keeps cookies, signs in as `login` and consents. */
async function atProvider(start: string, login: string): Promise<string> {
  const jar = new Map<string, string>();
  const go = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0]!;
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (value && !/expires=Thu, 01 Jan 1970/i.test(c)) jar.set(name, value);
      else jar.delete(name);
    }
    return res;
  };
  let res = await go(start);
  for (let step = 0; step < 10; step++) {
    const location = res.headers.get("location");
    if (location?.startsWith(APP)) return location;
    if (location) {
      res = await go(new URL(location, issuer).href);
      continue;
    }
    const html = await res.text();
    const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1];
    assert.ok(action, `a login or consent form (${res.status})`);
    const form = new URLSearchParams();
    for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) form.set(m[1]!, m[2]!);
    if (html.includes('name="login"')) {
      form.set("login", login);
      form.set("password", "any");
    }
    res = await go(new URL(action, issuer).href, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  throw new Error("the provider did not send the browser back to the app");
}

test("oidc() signs a user in through oidc-provider, ending in a session cookie", async () => {
  const session = sessions({ secret: "oidc-provider-test-session-secret-0123456789", user: ({ userId }) => ({ id: userId, roles: [] }) });
  const seen: Record<string, unknown>[] = [];
  const sso = oidc({
    issuer,
    clientId: "inferlo-app",
    clientSecret: "provider-test-client-secret",
    session,
    userId: (claims) => {
      seen.push(claims);
      return claims.email_verified ? `user-${claims.sub}` : null;
    },
  });
  const app = createApp({ auth: session, routes: [{ me: route.get("/me").handle(({ user }) => user) }, sso], logger: { info() {}, error() {} } });

  const login = await app.fetch(new Request(`${APP}/auth/login?returnTo=/dashboard`));
  assert.equal(login.status, 302);
  const pending = login.headers.getSetCookie()[0]!.split(";")[0]!;
  const back = await atProvider(login.headers.get("location")!, "ada");
  assert.equal(new URL(back).searchParams.get("iss"), issuer, "the provider names itself (RFC 9207)");

  const callback = await app.fetch(new Request(back, { headers: { cookie: pending } }));
  assert.equal(callback.status, 302, await callback.clone().text());
  assert.equal(callback.headers.get("location"), "/dashboard");
  assert.equal(seen[0]?.sub, "ada");
  assert.equal(seen[0]?.email, "ada@example.com");
  const sessionCookie = callback.headers.getSetCookie().find((c) => c.startsWith("inferlo_session="))!.split(";")[0]!;
  assert.deepEqual(await (await app.fetch(new Request(`${APP}/me`, { headers: { cookie: sessionCookie } }))).json(), { id: "user-ada", roles: [] });

  const replay = await app.fetch(new Request(back, { headers: { cookie: pending } }));
  assert.equal(replay.status, 400, "the provider refuses a used code");
});
