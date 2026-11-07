import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp, InferloError, jwt, route, type JwtAlgorithm } from "../src/index.ts";

const quiet = { info() {}, error() {} };
const AUDIENCE = "https://api.example.com";

function b64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PARAMS: Record<string, { gen: RsaHashedKeyGenParams | EcKeyGenParams | { name: string }; sign: AlgorithmIdentifier | RsaPssParams | EcdsaParams }> = {
  RS256: { gen: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } },
  PS384: { gen: { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" }, sign: { name: "RSA-PSS", saltLength: 48 } },
  ES256: { gen: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { gen: { name: "ECDSA", namedCurve: "P-384" }, sign: { name: "ECDSA", hash: "SHA-384" } },
  EdDSA: { gen: { name: "Ed25519" }, sign: { name: "Ed25519" } },
};

interface SigningKey {
  alg: JwtAlgorithm;
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string; alg?: string; use?: string };
}

async function makeKey(alg: keyof typeof PARAMS, kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(PARAMS[alg]!.gen, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid: string };
  delete jwk.key_ops;
  return { alg: alg as JwtAlgorithm, kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, use: "sig", alg } };
}

async function sign(key: SigningKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg: key.alg, typ: "JWT", kid: key.kid, ...header }));
  const body = b64url(JSON.stringify(claims));
  const signature = new Uint8Array(await crypto.subtle.sign(PARAMS[key.alg]!.sign, key.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}

async function signHmac(secret: string, claims: Record<string, unknown>, alg = "HS256"): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: `SHA-${alg.slice(2)}` }, false, ["sign"]);
  const head = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const body = b64url(JSON.stringify(claims));
  return `${head}.${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`))))}`;
}

/** A stand-in identity provider: its OpenID configuration and key set, with a count of key set fetches. */
class Provider {
  server!: Server;
  issuer = "";
  keys: SigningKey[] = [];
  jwksRequests = 0;
  failing = false;
  async start() {
    this.server = createServer((req, res) => {
      if (this.failing) {
        res.writeHead(500).end();
        return;
      }
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: this.issuer, jwks_uri: `${this.issuer}/jwks.json` }));
        return;
      }
      if (req.url === "/jwks.json") {
        this.jwksRequests++;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: this.keys.map((k) => k.jwk) }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const me = route.get("/me").handle(({ user }) => user);
const adminOnly = route.get("/admin", { auth: "admin" }).handle(() => ({ ok: true }));
const open = route.get("/open", { auth: "public" }).handle(({ user }) => ({ user }));

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe("jwt() with an OpenID Connect provider", () => {
  const provider = new Provider();
  let app: ReturnType<typeof createApp>;
  let rs: SigningKey;
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (extra: Record<string, unknown> = {}) => ({ iss: provider.issuer, aud: AUDIENCE, sub: "user-1", exp: now() + 300, iat: now(), email: "ada@example.com", roles: ["admin"], ...extra });

  before(async () => {
    await provider.start();
    rs = await makeKey("RS256", "rs-1");
    provider.keys = [rs, await makeKey("ES256", "es-1"), await makeKey("ES384", "es-2"), await makeKey("PS384", "ps-1"), await makeKey("EdDSA", "ed-1")];
    app = createApp({ routes: [{ me, adminOnly, open }], auth: jwt({ issuer: provider.issuer, audience: AUDIENCE }), logger: quiet });
  });
  after(() => provider.stop());

  test("a valid token signs the user in, with keys found through the OpenID configuration", async () => {
    const res = await app.request("/me", bearer(await sign(rs, claims())));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: "user-1", email: "ada@example.com", roles: ["admin"] });
    assert.equal((await app.request("/admin", bearer(await sign(rs, claims())))).status, 200);
    assert.equal((await app.request("/admin", bearer(await sign(rs, claims({ roles: ["member"] }))))).status, 403);
  });

  test("RS256, PS384, ES256, ES384 and EdDSA signatures are checked", async () => {
    for (const key of provider.keys) {
      const res = await app.request("/me", bearer(await sign(key, claims({ sub: `user-${key.alg}` }))));
      assert.equal(res.status, 200, key.alg);
      assert.equal(((await res.json()) as { id: string }).id, `user-${key.alg}`);
    }
  });

  test("tokens that are not valid for this API sign nobody in", async () => {
    const other = await makeKey("RS256", "rs-1");
    const bad = [
      await sign(other, claims()), // signed with another key under the same key id
      await sign(rs, claims({ iss: "https://other.example" })),
      await sign(rs, claims({ aud: "https://other-api.example" })),
      await sign(rs, claims({ exp: now() - 120 })),
      await sign(rs, claims({ exp: undefined })),
      await sign(rs, claims({ nbf: now() + 600 })),
      await sign(rs, claims({ iat: now() + 600 })),
      await sign(rs, claims({ sub: "" })),
      await sign(rs, claims(), { crit: ["b64"] }),
      await sign(rs, claims(), { kid: "unknown" }),
      (await sign(rs, claims())).slice(0, -4) + "AAAA",
      "not.a.token",
      "a.b",
      `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims()))}.`,
      "x".repeat(20_000),
    ];
    for (const [i, token] of bad.entries()) {
      const res = await app.request("/me", bearer(token));
      assert.equal(res.status, 401, `token ${i}`);
    }
    assert.deepEqual(await (await app.request("/open", bearer(bad[0]!))).json(), { user: null });
    assert.equal((await app.request("/me")).status, 401);
  });

  test("an HS256 token signed with the RSA public key is refused (algorithm confusion)", async () => {
    const forged = await signHmac(JSON.stringify(rs.jwk), claims());
    assert.equal((await app.request("/me", bearer(forged))).status, 401);
    const es = provider.keys.find((k) => k.alg === "ES256")!;
    // An ES256 key id with an RS256 header: the key type must match the algorithm.
    assert.equal((await app.request("/me", bearer(await sign(rs, claims(), { kid: es.kid })))).status, 401);
  });

  test("audience lists and the clock tolerance", async () => {
    assert.equal((await app.request("/me", bearer(await sign(rs, claims({ aud: ["https://other.example", AUDIENCE] }))))).status, 200);
    assert.equal((await app.request("/me", bearer(await sign(rs, claims({ exp: now() - 30 }))))).status, 200, "within 60 s of expiry");
    const strict = createApp({ routes: [{ me }], auth: jwt({ issuer: provider.issuer, audience: [AUDIENCE, "b"], clockToleranceSeconds: 0 }), logger: quiet });
    assert.equal((await strict.request("/me", bearer(await sign(rs, claims({ exp: now() - 30 }))))).status, 401);
    assert.equal((await strict.request("/me", bearer(await sign(rs, claims({ aud: "b" }))))).status, 200);
  });

  test("keys are cached, and a new key id (key rotation) fetches the key set again", async () => {
    const auth = jwt({ issuer: provider.issuer, audience: AUDIENCE });
    const rotating = createApp({ routes: [{ me }], auth, logger: quiet });
    const before = provider.jwksRequests;
    for (let i = 0; i < 5; i++) assert.equal((await rotating.request("/me", bearer(await sign(rs, claims())))).status, 200);
    assert.equal(provider.jwksRequests, before + 1, "one fetch for five requests");

    const rotated = await makeKey("ES256", "es-new");
    provider.keys.push(rotated);
    // Within 30 s of the last fetch an unknown key id does not fetch again, so random key ids cannot flood the provider.
    assert.equal((await rotating.request("/me", bearer(await sign(rotated, claims())))).status, 401);
    assert.equal(provider.jwksRequests, before + 1);
    const later = jwt({ issuer: provider.issuer, audience: AUDIENCE, jwksUrl: `${provider.issuer}/jwks.json` });
    const app2 = createApp({ routes: [{ me }], auth: later, logger: quiet });
    assert.equal((await app2.request("/me", bearer(await sign(rotated, claims())))).status, 200, "a fresh fetch finds the new key");
  });

  test("when the provider cannot be reached, requests with a token answer 503 IL3008", async () => {
    provider.failing = true;
    try {
      const down = createApp({ routes: [{ me, open }], auth: jwt({ issuer: provider.issuer, audience: AUDIENCE }), logger: quiet });
      const res = await down.request("/me", bearer(await sign(rs, claims())));
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "IL3008");
      assert.equal((await down.request("/me")).status, 401, "requests without a token do not need the keys");
      assert.equal((await down.request("/open")).status, 200);
    } finally {
      provider.failing = false;
    }
  });

  test("user maps the claims, and null refuses the token", async () => {
    const mapped = createApp({
      routes: [{ me }],
      auth: jwt({
        issuer: provider.issuer,
        audience: AUDIENCE,
        user: (c) => (c.sub === "blocked" ? null : { id: c.sub, roles: (c.permissions as string[] | undefined) ?? [], org: c.org_id }),
      }),
      logger: quiet,
    });
    const res = await mapped.request("/me", bearer(await sign(rs, claims({ permissions: ["notes:write"], org_id: "org_1" }))));
    assert.deepEqual(await res.json(), { id: "user-1", roles: ["notes:write"], org: "org_1" });
    assert.equal((await mapped.request("/me", bearer(await sign(rs, claims({ sub: "blocked" }))))).status, 401);
  });
});

describe("jwt() with a shared secret", () => {
  const secret = "a-shared-signing-secret-of-32-characters-or-more";
  const app = createApp({ routes: [{ me }], auth: jwt({ issuer: "https://project.supabase.co/auth/v1", audience: "authenticated", secret }), logger: quiet });
  const claims = { iss: "https://project.supabase.co/auth/v1", aud: "authenticated", sub: "u1", exp: Math.floor(Date.now() / 1000) + 60 };

  test("HS256 tokens signed with the secret are accepted, others are not", async () => {
    assert.equal((await app.request("/me", bearer(await signHmac(secret, claims)))).status, 200);
    assert.equal((await app.request("/me", bearer(await signHmac(secret + "x", claims)))).status, 401);
    assert.equal((await app.request("/me", bearer(await signHmac(secret, claims, "HS512")))).status, 401, "HS512 is not in the default list");
    const both = createApp({ routes: [{ me }], auth: jwt({ issuer: claims.iss, audience: "authenticated", secret, algorithms: ["HS256", "HS512"] }), logger: quiet });
    assert.equal((await both.request("/me", bearer(await signHmac(secret, claims, "HS512")))).status, 200);
  });
});

describe("jwt() options", () => {
  test("invalid options raise IL6042", () => {
    const is6042 = (e: unknown) => e instanceof InferloError && e.code === "IL6042" && Boolean(e.fix);
    const base = { issuer: "https://login.example.com/", audience: AUDIENCE };
    assert.throws(() => jwt(undefined as never), is6042);
    assert.throws(() => jwt({ audience: AUDIENCE } as never), is6042);
    assert.throws(() => jwt({ issuer: base.issuer } as never), is6042, "the audience is required");
    assert.throws(() => jwt({ ...base, audience: [] }), is6042);
    assert.throws(() => jwt({ ...base, issuer: "http://login.example.com/" }), is6042, "https only");
    assert.throws(() => jwt({ ...base, jwksUrl: "http://keys.example.com/jwks.json" }), is6042);
    assert.throws(() => jwt({ ...base, secret: "short" }), is6042);
    assert.throws(() => jwt({ ...base, secret: "s".repeat(32), jwksUrl: "https://keys.example.com/jwks.json" }), is6042);
    assert.throws(() => jwt({ ...base, algorithms: ["HS256"] }), is6042, "HS256 needs a secret");
    assert.throws(() => jwt({ ...base, secret: "s".repeat(32), algorithms: ["RS256"] }), is6042);
    assert.throws(() => jwt({ ...base, algorithms: ["none" as never] }), is6042);
    assert.throws(() => jwt({ ...base, clockToleranceSeconds: 3600 }), is6042);
    assert.throws(() => jwt({ ...base, cacheMs: 10 }), is6042);
    assert.throws(() => jwt({ ...base, users: () => null } as never), is6042);
    assert.throws(() => jwt({ ...base, user: "sub" } as never), is6042);
    assert.doesNotThrow(() => jwt({ ...base, jwksUrl: "https://login.example.com/.well-known/jwks.json", roles: () => [], tenant: () => null }));
  });

  test("roles and tenant are passed on", () => {
    const auth = jwt({ issuer: "https://login.example.com/", audience: AUDIENCE, roles: () => ["x"], tenant: () => "t" });
    assert.deepEqual(auth.roles?.({ id: "1" }), ["x"]);
    assert.equal(auth.tenant?.({ id: "1" }), "t");
  });
});
