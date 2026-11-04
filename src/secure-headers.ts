/**
 * Secure response headers, sent on every response unless the response already has the header:
 *
 *   createApp({ secureHeaders: { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": false } })
 *   createApp({ secureHeaders: false })   // none of them
 */
import { InferloError } from "./errors.ts";

/** Header name to value; false leaves the header out. Names are case-insensitive. */
export type SecureHeadersConfig = Record<string, string | false>;

/** Sent on every response by default. Strict-Transport-Security is sent only over HTTPS. */
export const DEFAULT_SECURE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy": "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const HSTS = "strict-transport-security";
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The headers to send (lowercase names), from createApp({ secureHeaders }). */
export function resolveSecureHeaders(option: boolean | SecureHeadersConfig | undefined): [string, string][] {
  if (option === false) return [];
  const fix = 'Use createApp({ secureHeaders: { "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": false } }), or secureHeaders: false to send none.';
  if (option !== undefined && option !== true && (typeof option !== "object" || option === null || Array.isArray(option))) {
    throw new InferloError("IL6016", `secureHeaders must be true, false or an object of header names, got ${JSON.stringify(option)}.`, { fix });
  }
  const headers = new Map(Object.entries(DEFAULT_SECURE_HEADERS));
  for (const [name, value] of Object.entries(typeof option === "object" ? option : {})) {
    if (!TOKEN.test(name)) throw new InferloError("IL6016", `secureHeaders: "${name}" is not a valid header name.`, { fix });
    if (value === false) {
      headers.delete(name.toLowerCase());
      continue;
    }
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw new InferloError("IL6016", `secureHeaders["${name}"] must be a string (without line breaks) or false, got ${JSON.stringify(value)}.`, { fix });
    }
    headers.set(name.toLowerCase(), value);
  }
  return [...headers];
}

/** Add the headers the response does not set itself. Strict-Transport-Security only when the request came over HTTPS. */
export function applySecureHeaders(response: Response, headers: [string, string][], https: boolean): Response {
  const missing = headers.filter(([name]) => (name !== HSTS || https) && !response.headers.has(name));
  if (!missing.length) return response;
  try {
    for (const [name, value] of missing) response.headers.set(name, value);
    return response;
  } catch {
    // Immutable headers (Response.redirect, a fetch() response passed through): copy the response.
    const copy = new Response(response.body, response);
    for (const [name, value] of missing) copy.headers.set(name, value);
    return copy;
  }
}
