/**
 * Deprecated routes: route.get(path, { deprecated: { since: "2026-11-01", sunset: "2027-06-30", link } })
 * sends Deprecation (RFC 9745), Sunset (RFC 8594) and Link rel="deprecation" headers, and marks the
 * operation deprecated in OpenAPI, describe() and MCP.
 */
import { InferloError } from "./errors.ts";

export interface Deprecation {
  /** When the route was deprecated (a date such as "2026-11-01" or a Date). Sent as the Deprecation header. */
  since?: string | Date;
  /** When the route will stop working. Sent as the Sunset header. Must be after since. */
  sunset?: string | Date;
  /** A page that explains the change and what to use instead (https). Sent as Link: <...>; rel="deprecation". */
  link?: string;
}

export interface ResolvedDeprecation {
  since?: Date;
  sunset?: Date;
  link?: string;
  /** Response headers, lowercase names. */
  headers: [name: string, value: string][];
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  // Dates ("2026-11-01") or full ISO 8601 timestamps; nothing locale-dependent.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/** Checks a route's deprecated option; undefined when the route is not deprecated. */
export function resolveDeprecation(option: unknown, where: string): ResolvedDeprecation | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return { headers: [] };
  const problems: string[] = [];
  const resolved: ResolvedDeprecation = { headers: [] };
  if (!option || typeof option !== "object" || Array.isArray(option)) problems.push("deprecated must be true or { since, sunset, link }");
  else {
    const { since, sunset, link, ...rest } = option as Record<string, unknown>;
    if (since !== undefined && !(resolved.since = toDate(since))) problems.push(`since must be a date such as "2026-11-01" or a Date, got ${JSON.stringify(since)}`);
    if (sunset !== undefined && !(resolved.sunset = toDate(sunset))) problems.push(`sunset must be a date such as "2027-06-30" or a Date, got ${JSON.stringify(sunset)}`);
    if (resolved.since && resolved.sunset && resolved.sunset.getTime() <= resolved.since.getTime()) problems.push("sunset must be after since");
    if (link !== undefined) {
      let url: URL | undefined;
      try {
        url = typeof link === "string" ? new URL(link) : undefined;
      } catch {
        url = undefined;
      }
      if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || /[\s<>"]/.test(String(link))) problems.push(`link must be an http or https URL, got ${JSON.stringify(link)}`);
      else resolved.link = url.href;
    }
    for (const key of Object.keys(rest)) problems.push(`unknown option "${key}"`);
  }
  if (problems.length) {
    throw new InferloError("IL6021", `Invalid deprecated option on ${where}: ${problems.join("; ")}.`, {
      fix: 'Use deprecated: true, or deprecated: { since: "2026-11-01", sunset: "2027-06-30", link: "https://example.com/docs/migrate-to-v2" }.',
    });
  }
  // RFC 9745: Deprecation: @<unix seconds>. RFC 8594: Sunset: <HTTP date>.
  if (resolved.since) resolved.headers.push(["deprecation", `@${Math.floor(resolved.since.getTime() / 1000)}`]);
  if (resolved.sunset) resolved.headers.push(["sunset", resolved.sunset.toUTCString()]);
  if (resolved.link) resolved.headers.push(["link", `<${resolved.link}>; rel="deprecation"; type="text/html"`]);
  return resolved;
}

/** The deprecation as JSON for describe() and OpenAPI: dates as YYYY-MM-DD or ISO timestamps. */
export function describeDeprecation(d: ResolvedDeprecation): { since?: string; sunset?: string; link?: string } {
  const day = (date: Date) => (date.getTime() % 86_400_000 === 0 ? date.toISOString().slice(0, 10) : date.toISOString());
  return { ...(d.since ? { since: day(d.since) } : {}), ...(d.sunset ? { sunset: day(d.sunset) } : {}), ...(d.link ? { link: d.link } : {}) };
}
