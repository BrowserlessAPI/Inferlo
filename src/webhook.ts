/**
 * Incoming webhook signatures: route.post(path, { auth: "public", webhook: { scheme, secret } }) checks the HMAC
 * signature the sender computed over the raw request body before the body is parsed and the handler runs.
 *
 *   "standard": Standard Webhooks (webhook-id, webhook-timestamp and webhook-signature headers, "v1,<base64>"
 *               signatures over "<id>.<timestamp>.<body>", secrets "whsec_<base64>"), used by Svix, Clerk, Resend,
 *               Supabase, OpenAI and others.
 *   "stripe":   the Stripe-Signature header ("t=<timestamp>,v1=<hex>"), signatures over "<timestamp>.<body>".
 *   "github":   the X-Hub-Signature-256 header ("sha256=<hex>"), a signature over the body.
 *
 * Signatures are compared with Web Crypto's HMAC verify (constant time), any of several secrets may match (for
 * rotation), and the schemes with a timestamp refuse requests outside toleranceMs (default 5 minutes) so a captured
 * request cannot be replayed later. Failures answer 401 IL3012 without saying which part was wrong.
 */
import { InferloError } from "./errors.ts";

export type WebhookScheme = "standard" | "stripe" | "github";

export interface RouteWebhook {
  /** How the sender signs: "standard" (Standard Webhooks, Svix), "stripe" or "github". */
  scheme: WebhookScheme;
  /** The signing secret, or several during a rotation (any one may match). */
  secret: string | readonly string[];
  /** For "standard" and "stripe": how far the signed timestamp may be from now, in milliseconds. Default 300000. */
  toleranceMs?: number;
}

interface ResolvedWebhook {
  scheme: WebhookScheme;
  keys: Promise<CryptoKey[]>;
  toleranceMs: number;
}

const SCHEMES: readonly WebhookScheme[] = ["standard", "stripe", "github"];
const fix = 'Use route.post(path, { auth: "public", webhook: { scheme: "stripe", secret: settings.STRIPE_WEBHOOK_SECRET } }) with scheme "standard", "stripe" or "github" and the signing secret from the provider.';
const resolved = new WeakMap<object, ResolvedWebhook>();

function invalid(where: string, message: string): InferloError {
  return new InferloError("IL6066", `${where}: ${message}`, { fix });
}

function base64Bytes(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

function hexBytes(text: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return undefined;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The key bytes of a secret: Standard Webhooks secrets are "whsec_" and base64; Stripe and GitHub use the text. */
function secretBytes(scheme: WebhookScheme, secret: string): Uint8Array | undefined {
  if (scheme === "standard") return base64Bytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  return new TextEncoder().encode(secret);
}

/** Checks a route's webhook option at startup and prepares its keys. Raises IL6066. */
export function checkRouteWebhook(option: unknown, route: { method: string; options: { auth?: string; tool?: unknown; body?: unknown } }, where: string, hasFiles: boolean): void {
  if (typeof option !== "object" || option === null || Array.isArray(option)) throw invalid(where, "webhook must be { scheme, secret, toleranceMs }.");
  const unknown = Object.keys(option).filter((key) => key !== "scheme" && key !== "secret" && key !== "toleranceMs");
  if (unknown.length) throw invalid(where, `webhook has unknown option ${unknown.map((k) => `"${k}"`).join(", ")}.`);
  const { scheme, secret, toleranceMs } = option as RouteWebhook;
  if (!SCHEMES.includes(scheme)) throw invalid(where, `webhook.scheme must be "standard", "stripe" or "github", got ${JSON.stringify(scheme)}.`);
  const secrets = typeof secret === "string" ? [secret] : Array.isArray(secret) ? [...secret] : [];
  if (secrets.length === 0 || secrets.some((s) => typeof s !== "string" || s.length === 0)) {
    throw invalid(where, "webhook.secret must be the signing secret (a non-empty string) or a list of them; is the environment variable set?");
  }
  if (scheme === "standard" && secrets.some((s) => !secretBytes(scheme, s)?.length)) throw invalid(where, 'webhook.secret of scheme "standard" must be a "whsec_..." secret (base64 after the prefix).');
  if (toleranceMs !== undefined) {
    if (scheme === "github") throw invalid(where, 'webhook.toleranceMs is only used by "standard" and "stripe"; GitHub signatures have no timestamp.');
    if (typeof toleranceMs !== "number" || !Number.isInteger(toleranceMs) || toleranceMs < 1000 || toleranceMs > 3_600_000) throw invalid(where, `webhook.toleranceMs must be a whole number from 1000 to 3600000, got ${JSON.stringify(toleranceMs)}.`);
  }
  if (route.method !== "POST" && route.method !== "PUT" && route.method !== "PATCH") throw invalid(where, "webhook is only for POST, PUT and PATCH routes.");
  if ((route.options.auth ?? "user") !== "public") throw invalid(where, 'a webhook route needs auth: "public": the sender proves itself with the signature, not as a signed-in user.');
  if (route.options.tool) throw invalid(where, "a webhook route cannot be an AI tool (tool: true): tools are not signed by the webhook sender.");
  if (hasFiles) throw invalid(where, "a webhook route cannot take t.file() uploads; webhooks send JSON or form bodies.");
  const keys = Promise.all(secrets.map((s) => crypto.subtle.importKey("raw", secretBytes(scheme, s)! as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["verify"])));
  keys.catch(() => {});
  resolved.set(option, { scheme, keys, toleranceMs: toleranceMs ?? 300_000 });
}

function refused(message: string): InferloError {
  return new InferloError("IL3012", message, { status: 401, fix: "Send the request from the webhook provider, signed with the secret this route is configured with." });
}

async function anyKeyVerifies(keys: CryptoKey[], signatures: Uint8Array[], data: string): Promise<boolean> {
  const bytes = new TextEncoder().encode(data);
  for (const signature of signatures) {
    if (signature.byteLength !== 32) continue;
    for (const key of keys) if (await crypto.subtle.verify("HMAC", key, signature as BufferSource, bytes)) return true;
  }
  return false;
}

function checkTimestamp(seconds: string | undefined, toleranceMs: number, now: number): number {
  if (!seconds || !/^\d{1,12}$/.test(seconds)) throw refused("The webhook signature is missing or invalid.");
  const ms = Number(seconds) * 1000;
  if (Math.abs(now - ms) > toleranceMs) throw refused("The webhook timestamp is too old or in the future.");
  return ms;
}

/** Verifies a request to a webhook route against its raw body text. Raises 401 IL3012. */
export async function verifyWebhook(option: object, headers: Headers, body: string, now = Date.now()): Promise<void> {
  const config = resolved.get(option);
  if (!config) throw new Error("webhook option was not checked at startup");
  const keys = await config.keys;
  if (config.scheme === "github") {
    const header = headers.get("x-hub-signature-256") ?? "";
    const signature = header.startsWith("sha256=") ? hexBytes(header.slice(7)) : undefined;
    if (!signature || !(await anyKeyVerifies(keys, [signature], body))) throw refused("The webhook signature is missing or invalid.");
    return;
  }
  if (config.scheme === "stripe") {
    const parts = (headers.get("stripe-signature") ?? "").split(",").map((p) => p.trim().split("="));
    const t = parts.find(([k]) => k === "t")?.[1];
    const signatures = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => hexBytes(v!)).filter((s): s is Uint8Array => s !== undefined);
    if (!signatures.length) throw refused("The webhook signature is missing or invalid.");
    checkTimestamp(t, config.toleranceMs, now);
    if (!(await anyKeyVerifies(keys, signatures, `${t}.${body}`))) throw refused("The webhook signature is missing or invalid.");
    return;
  }
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp") ?? undefined;
  const signatures = (headers.get("webhook-signature") ?? "").split(" ").filter((s) => s.startsWith("v1,")).map((s) => base64Bytes(s.slice(3))).filter((s): s is Uint8Array => s !== undefined);
  if (!id || !signatures.length) throw refused("The webhook signature is missing or invalid.");
  checkTimestamp(timestamp, config.toleranceMs, now);
  if (!(await anyKeyVerifies(keys, signatures, `${id}.${timestamp}.${body}`))) throw refused("The webhook signature is missing or invalid.");
}
