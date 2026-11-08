/**
 * Idempotency keys: route.post(path, { idempotency: true }) runs a request with an Idempotency-Key header once and
 * answers repeats of it with the first answer, so clients can safely retry a payment or an order after a timeout.
 *
 * The key is scoped to the route and the signed-in user (or "anonymous"). The first request claims it atomically
 * in the app cache (memory, database or Redis), so a repeat that arrives while it still runs answers 409 IL2018;
 * once it finished, repeats get the stored answer with "Idempotent-Replayed: true", and a repeat with a different
 * request (method, path, query or body) answers 422 IL2019. 5xx answers and errors release the key, so the
 * request can be retried. Answers that set a cookie, event streams and bodies over 1 MB are not stored: repeats
 * of those answer 409 IL2018.
 */
import { InferloError } from "./errors.ts";
import type { CacheStore } from "./cache.ts";

/** The route option idempotency: true, or { ttlMs, required }. */
export interface RouteIdempotency {
  /** How long the answer is kept for repeats, in milliseconds (1 second to 30 days). Default 86_400_000 (24 hours). */
  ttlMs?: number;
  /** true: requests without an Idempotency-Key header answer 400 IL2017. Default false (they run as usual). */
  required?: boolean;
}

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REPLAYED_HEADER = "idempotent-replayed";
const DEFAULT_TTL_MS = 86_400_000;
const MAX_TTL_MS = 30 * 86_400_000;
const MAX_STORED_BYTES = 1024 * 1024;
const KEY = /^[\x21-\x7e]{1,255}$/;
const METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Not stored with an answer: they belong to the request that gets the replay.
const SKIPPED_HEADERS = new Set(["set-cookie", "x-request-id", "date", "content-length", "retry-after", "ratelimit", "ratelimit-policy", "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"]);

/** Check a route's idempotency option at startup. Raises IL6058. */
export function checkRouteIdempotency(option: unknown, method: string, where: string): void {
  const problems: string[] = [];
  if (!METHODS.has(method)) problems.push("only POST, PUT, PATCH and DELETE routes take idempotency keys");
  if (option !== true) {
    const o = option as RouteIdempotency;
    if (typeof o !== "object" || o === null || Array.isArray(o)) problems.push("it must be true or an object");
    else {
      for (const key of Object.keys(o)) if (key !== "ttlMs" && key !== "required") problems.push(`unknown option "${key}"`);
      if (o.ttlMs !== undefined && (!Number.isInteger(o.ttlMs) || o.ttlMs < 1000 || o.ttlMs > MAX_TTL_MS)) problems.push("ttlMs must be a whole number of milliseconds from 1000 to 30 days");
      if (o.required !== undefined && typeof o.required !== "boolean") problems.push("required must be true or false");
    }
  }
  if (problems.length) {
    throw new InferloError("IL6058", `Invalid idempotency option on ${where}: ${problems.join(", ")}.`, {
      fix: "Use route.post(path, { idempotency: true }) or { idempotency: { ttlMs: 86_400_000, required: true } }.",
    });
  }
}

/** What the app cache keeps for one key. */
interface Entry {
  state: "running" | "done";
  fingerprint: string;
  /** Done and stored: the answer to replay. */
  answer?: { status: number; headers: [string, string][]; body: string | null };
}

/** Base64 of the bytes, built in chunks so large bodies do not overflow the call stack. */
function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
const sha256 = async (text: string) => toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** JSON with files described by name, type and size, for the request fingerprint. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => (typeof Blob !== "undefined" && v instanceof Blob ? { file: (v as File).name ?? "", type: v.type, size: v.size } : v));
}

export interface IdempotencyRequest {
  store: CacheStore;
  option: true | RouteIdempotency;
  method: string;
  /** The route pattern, e.g. /orders/:id. */
  route: string;
  url: URL;
  key: string | null;
  userId: string | undefined;
  body: unknown;
  /** How long a running request may hold its key (the route's timeout plus a margin). */
  runningTtlMs: number;
}

/** Started: run the handler, then call finish(response) or release(). */
export interface IdempotencyClaim {
  finish(response: Response): Promise<void>;
  release(): Promise<void>;
}

const conflict = () =>
  new InferloError("IL2018", "A request with this Idempotency-Key is still running, or its answer could not be stored.", {
    status: 409,
    expose: true,
    fix: "Wait for the first request to finish and retry with the same key; send a new Idempotency-Key for a new request.",
  });

/**
 * Before the handler of a route with idempotency: null without a key (when it is optional), a Response to send
 * (a replay), or a claim. Raises IL2017 (no or invalid key), IL2018 (still running) and IL2019 (key reused).
 */
export async function beginIdempotency(r: IdempotencyRequest): Promise<IdempotencyClaim | Response | null> {
  const option = r.option === true ? {} : r.option;
  if (r.key === null) {
    if (!option.required) return null;
    throw new InferloError("IL2017", "This route needs an Idempotency-Key header.", { status: 400, expose: true, fix: "Send a new random key (a UUID) as the Idempotency-Key header with each request, and the same key when you retry it." });
  }
  if (!KEY.test(r.key)) {
    throw new InferloError("IL2017", "The Idempotency-Key header must be 1 to 255 visible ASCII characters.", { status: 400, expose: true, fix: "Send a random UUID as the Idempotency-Key header." });
  }
  const query = [...r.url.searchParams].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  const id = `idempotency:${await sha256(JSON.stringify([r.method, r.route, r.userId === undefined ? "anonymous" : `user:${r.userId}`, r.key]))}`;
  const fingerprint = await sha256(JSON.stringify([r.method, r.url.pathname, query, canonical(r.body)]));
  const running: Entry = { state: "running", fingerprint };
  if (!(await r.store.add(id, JSON.stringify(running), r.runningTtlMs))) {
    const json = await r.store.get(id);
    // Released or expired between the two calls: the caller may retry at once.
    if (json === undefined) throw conflict();
    const entry = JSON.parse(json) as Entry;
    if (entry.fingerprint !== fingerprint) {
      throw new InferloError("IL2019", "This Idempotency-Key was already used for a different request.", {
        status: 422,
        expose: true,
        fix: "Send a new Idempotency-Key for each new request; reuse a key only to retry exactly the same request.",
      });
    }
    if (entry.state !== "done" || !entry.answer) throw conflict();
    const headers = new Headers(entry.answer.headers);
    headers.set(REPLAYED_HEADER, "true");
    const body = entry.answer.body === null ? null : Uint8Array.from(atob(entry.answer.body), (c) => c.charCodeAt(0));
    return new Response(body, { status: entry.answer.status, headers });
  }
  const ttlMs = option.ttlMs ?? DEFAULT_TTL_MS;
  let settled = false;
  return {
    async finish(response) {
      if (settled) return;
      settled = true;
      if (response.status >= 500) return void (await r.store.delete(id));
      const done: Entry = { state: "done", fingerprint };
      const length = Number(response.headers.get("content-length") ?? "0");
      const storable = !response.headers.has("set-cookie") && !(response.headers.get("content-type") ?? "").includes("text/event-stream") && !(length > MAX_STORED_BYTES);
      if (storable) {
        const bytes = response.body ? new Uint8Array(await response.clone().arrayBuffer()) : null;
        if (!bytes || bytes.length <= MAX_STORED_BYTES) {
          const headers: [string, string][] = [];
          response.headers.forEach((value, name) => {
            if (!SKIPPED_HEADERS.has(name)) headers.push([name, value]);
          });
          done.answer = { status: response.status, headers, body: bytes ? toBase64(bytes) : null };
        }
      }
      await r.store.set(id, JSON.stringify(done), ttlMs, []);
    },
    async release() {
      if (settled) return;
      settled = true;
      await r.store.delete(id);
    },
  };
}
