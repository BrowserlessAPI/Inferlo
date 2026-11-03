/** Client IP addresses of incoming requests, recorded by serve() (Node) where the Request cannot carry them. */
export const clientIps = new WeakMap<Request, string>();

/**
 * The client IP of a request. With trustProxy, the first X-Forwarded-For address (set by your load balancer).
 * Otherwise the socket address from serve() (Node), Bun's server.requestIP or Deno's remoteAddr, or "unknown".
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
  return "unknown";
}
