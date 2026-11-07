/**
 * Cross-site request protection for auth that rides on a session cookie set by another library (Better Auth,
 * Auth.js): a request that changes data with the cookie must come from the app's own pages or a trusted origin.
 */
import { InferloError } from "./errors.ts";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origin of an http(s) URL, or null. */
export function originOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether a browser sent the request from the app's own pages or a trusted origin, as browsers mark requests:
 * Sec-Fetch-Site (same-origin or none passes), then Origin (the app's own host or a trusted origin passes). Clients
 * that send neither header are not browsers, so no other site can make them send the cookie.
 */
export function sameSiteRequest(req: Request, url: URL, trusted: ReadonlySet<string>): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null && trusted.has(origin)) return true;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none";
  if (origin === null) return true;
  if (origin === "null") return false;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? url.host);
  } catch {
    return false;
  }
}

/**
 * Throws 403 IL3007 for a request that changes data (POST, PUT, PATCH, DELETE) with the session cookie from another
 * site. Requests with an Authorization header are left alone: browsers never add one on their own.
 */
export function checkCrossSite(req: Request, url: URL, trusted: ReadonlySet<string>, hasCookie: (req: Request) => boolean, optionHint: string): void {
  if (SAFE_METHODS.has(req.method.toUpperCase()) || req.headers.has("authorization") || !hasCookie(req)) return;
  if (sameSiteRequest(req, url, trusted)) return;
  throw new InferloError("IL3007", "Requests that change data with the session cookie must come from the app's own pages.", {
    status: 403,
    fix: `Send the request from a page of the app's own origin, or add the page's origin to ${optionHint}.`,
  });
}
