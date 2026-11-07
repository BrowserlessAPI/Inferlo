import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

// A stand-in identity provider: its OpenID configuration and signing keys.
const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "key-1", use: "sig", alg: "RS256" };
delete (jwk as JsonWebKey).key_ops;
let issuer = "";
const server = createServer((req, res) => {
  if (req.url === "/.well-known/openid-configuration") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
  if (req.url === "/jwks") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.AUTH_ISSUER = issuer;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const b64url = (data: Uint8Array | string) =>
  btoa(String.fromCharCode(...(typeof data === "string" ? new TextEncoder().encode(data) : data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function token(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "key-1" }));
  const body = b64url(JSON.stringify({ iss: issuer, aud: "https://api.example.com", exp: now + 300, iat: now, ...claims }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

test("the provider's access tokens sign users in, and invalid tokens do not", async () => {
  const { app } = await import("../src/app.ts");
  const call = (path: string, auth?: string, json?: unknown) =>
    app.fetch(new Request(`http://localhost${path}`, { method: json ? "POST" : "GET", headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined }));

  const ada = await token({ sub: "auth0|ada", email: "ada@example.com", name: "Ada", roles: ["member"] });
  const created = await call("/notes", ada, { title: "From the SPA" });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { ownerId: string }).ownerId, "auth0|ada");
  const list = (await (await call("/notes", ada)).json()) as { title: string }[];
  assert.deepEqual(list.map((n) => n.title), ["From the SPA"]);

  assert.equal((await call("/notes")).status, 401);
  assert.equal((await call("/notes", await token({ sub: "auth0|ada", aud: "https://other-api.example.com" }))).status, 401, "the audience is checked");
  assert.equal((await call("/notes", await token({ sub: "auth0|ada", exp: Math.floor(Date.now() / 1000) - 3600 }))).status, 401, "expired tokens are refused");
  assert.equal((await call("/notes", ada.slice(0, -6) + "AAAAAA")).status, 401, "the signature is checked");
  const bob = await token({ sub: "auth0|bob" });
  assert.deepEqual(await (await call("/notes", bob)).json(), [], "users see only their own notes");
});
