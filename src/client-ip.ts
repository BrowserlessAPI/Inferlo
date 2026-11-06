/** Client IP addresses of incoming requests, recorded by serve() (Node) where the Request cannot carry them. */
export const clientIps = new WeakMap<Request, string>();

/**
 * Signals that abort when the client of a Node.js request disconnects, recorded by toNodeHandler and serve().
 * They are kept next to the Request instead of passed as its signal, because a Request built with a signal
 * follows it through a weak reference, which costs more than the rest of the conversion. ctx.signal uses them.
 */
export const clientSignals = new WeakMap<Request, AbortSignal>();

/** True in the Cloudflare Workers runtime (workerd), where navigator.userAgent is "Cloudflare-Workers". */
function onWorkers(): boolean {
  return (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
}

/**
 * The client IP of a request. With trustProxy, the first X-Forwarded-For address (set by your load balancer).
 * Otherwise the socket address from serve() (Node), Bun's server.requestIP or Deno's remoteAddr, the
 * CF-Connecting-IP header on Cloudflare Workers (set by Cloudflare, which replaces any value the client sends),
 * or "unknown".
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
  return "unknown";
}
