import { readEnv } from "./env.ts";

/** Client IP addresses of incoming requests, recorded by serve() (Node) where the Request cannot carry them. */
export const clientIps = new WeakMap<Request, string>();

/**
 * Signals that abort when the client of a Node.js request disconnects, recorded by toNodeHandler and serve().
 * They are kept next to the Request instead of passed as its signal, because a Request built with a signal
 * follows it through a weak reference, which costs more than the rest of the conversion. ctx.signal uses them.
 */
export const clientSignals = new WeakMap<Request, AbortSignal>();

/**
 * The Node.js request each Web Request was built from (toNodeHandler, fromNodeRequest, the h3 and WebSocket
 * bridges), so integrations can read what the host framework put on it, such as Passport's req.user.
 */
export const nodeRequests = new WeakMap<Request, object>();

/**
 * The context Netlify Functions 2.0 pass as the second argument of the handler (export default app.fetch):
 * it carries the client address in ip, a requestId and a waitUntil. Other platform objects (Bun's server,
 * Deno's info, Worker env) do not have both strings, so a Worker binding that happens to be named "ip" is not taken for it.
 */
export function netlifyContext(platform: unknown): { ip: string; waitUntil?(p: Promise<unknown>): void } | undefined {
  const p = platform as { ip?: unknown; requestId?: unknown } | null | undefined;
  return p && typeof p === "object" && typeof p.ip === "string" && typeof p.requestId === "string" ? (p as { ip: string }) : undefined;
}

/** True on Vercel Functions, where Vercel sets VERCEL=1 in the environment of every deployment and of vercel dev. */
function onVercel(): boolean {
  return readEnv("VERCEL") === "1";
}

/** True in the Cloudflare Workers runtime (workerd), where navigator.userAgent is "Cloudflare-Workers". */
function onWorkers(): boolean {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
}

/**
 * The client IP of a request. With trustProxy, the first X-Forwarded-For address (set by your load balancer).
 * Otherwise the socket address from serve() (Node), Bun's server.requestIP or Deno's remoteAddr, the
 * CF-Connecting-IP header on Cloudflare Workers (set by Cloudflare, which replaces any value the client sends),
 * the context.ip of Netlify Functions, the X-Real-IP header on Vercel (set by Vercel, which replaces any value the
 * client sends), or "unknown".
 */
export function clientIp(req: Request, trustProxy: boolean, platform: unknown): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  const recorded = clientIps.get(req);
  if (recorded) return recorded;
  const p = platform as { requestIP?(r: Request): { address?: string } | null; remoteAddr?: { hostname?: string } } | undefined;
  try {
    const address = p?.requestIP?.(req)?.address ?? p?.remoteAddr?.hostname;
    if (address) return address;
  } catch {
    // Not a Bun server or Deno info object.
  }
  if (onWorkers()) {
    const connecting = req.headers.get("cf-connecting-ip")?.trim();
    if (connecting) return connecting;
  }
  const netlify = netlifyContext(platform)?.ip.trim();
  if (netlify) return netlify;
  if (onVercel()) {
    const real = req.headers.get("x-real-ip")?.trim();
    if (real) return real;
  }
  return "unknown";
}

type WaitUntil = (p: Promise<unknown>) => void;

/**
 * The platform's waitUntil for work that outlives the response (ctx.waitUntil), so a serverless platform keeps the
 * function alive until it settles: the execution context of Cloudflare Workers (the third fetch argument), the
 * context of Netlify Functions (the second), or the request context Vercel Functions keep under
 * Symbol.for("@vercel/request-context") (what waitUntil from @vercel/functions uses). Undefined elsewhere: the app
 * then tracks the work itself, and app.close() waits for it.
 */
export function platformWaitUntil(rest: unknown[]): WaitUntil | undefined {
  const execution = rest[1] as { waitUntil?: WaitUntil } | null | undefined;
  if (typeof execution?.waitUntil === "function") return (p) => execution.waitUntil!(p);
  const netlify = netlifyContext(rest[0]);
  if (typeof netlify?.waitUntil === "function") return (p) => netlify.waitUntil!(p);
  const vercel = (globalThis as Record<symbol, { get?(): { waitUntil?: WaitUntil } | undefined } | undefined>)[Symbol.for("@vercel/request-context")];
  const context = vercel?.get?.();
  if (typeof context?.waitUntil === "function") return (p) => context.waitUntil!(p);
  return undefined;
}

/**
 * Keeps a server-sent events answer (ai.stream(...).toResponse()) open on Bun: Bun.serve closes a connection that
 * sends nothing for idleTimeout seconds (10 by default), which would cut off a model that pauses longer between
 * tokens. The platform is Bun's server (the second argument Bun passes to fetch), recognised by its requestIP and
 * timeout methods; elsewhere nothing happens.
 */
export function keepEventStreamOpen(platform: unknown, req: Request, response: Response): void {
  const server = platform as { requestIP?: unknown; timeout?: (req: Request, seconds: number) => void } | null | undefined;
  if (!server || typeof server.timeout !== "function" || typeof server.requestIP !== "function") return;
  if (!/^text\/event-stream\b/i.test(response.headers.get("content-type") ?? "")) return;
  try {
    server.timeout(req, 0);
  } catch {
    // An older Bun without per-request timeouts.
  }
}
