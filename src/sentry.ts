/**
 * Errors of an Inferlo app reported to Sentry, without a runtime dependency on a Sentry SDK:
 *
 *   import * as Sentry from "@sentry/node";
 *   import { sentryOnError } from "@browserlessapi/inferlo/sentry";
 *
 *   Sentry.init({ dsn: settings.SENTRY_DSN });
 *   export const app = createApp({ routes, jobs, onError: sentryOnError(Sentry) });
 *
 * Every unexpected error (500 answers, including failed AI calls and database errors in routes, failed WebSocket
 * messages and failed job attempts) is sent with Sentry.captureException, after Inferlo's secret redaction, with:
 *
 * - tags: inferlo.source ("request", "websocket" or "job"), inferlo.route, inferlo.job, inferlo.final,
 *   request_id, tenant_id and trace_id when present, so issues can be searched and grouped by them;
 * - user: { id } of the signed-in user (only the id, never the email or name);
 * - the "inferlo" context with every field Inferlo knows (method, path, job id, attempt, ...).
 *
 * Any Sentry SDK with captureException(error, captureContext) works: @sentry/node, @sentry/bun, @sentry/deno,
 * @sentry/cloudflare and @sentry/nextjs (8 and later; tested on 9 and the latest).
 */
import { InferloError } from "./errors.ts";
import type { ErrorInfo, OnError } from "./logging.ts";

/** The function of a Sentry SDK that Inferlo calls: Sentry.captureException(error, { tags, user, contexts }). */
export interface SentryLike {
  captureException(exception: unknown, captureContext?: any): unknown;
}

const fix = 'Pass the Sentry SDK: import * as Sentry from "@sentry/node"; Sentry.init({ dsn }); createApp({ onError: sentryOnError(Sentry) }).';

/** createApp({ onError: sentryOnError(Sentry) }): reports the app's unexpected errors to Sentry. */
export function sentryOnError(sentry: SentryLike): OnError {
  if (!sentry || (typeof sentry !== "object" && typeof sentry !== "function") || typeof (sentry as { captureException?: unknown }).captureException !== "function") {
    throw new InferloError("IL6056", `sentryOnError() needs a Sentry SDK with captureException, got ${sentry === null ? "null" : typeof sentry === "object" ? "an object without captureException" : typeof sentry}.`, { fix });
  }
  return (error: unknown, info: ErrorInfo) => {
    const tags: Record<string, string> = { "inferlo.source": info.source };
    if (info.route) tags["inferlo.route"] = info.route;
    if (info.job) tags["inferlo.job"] = info.job;
    if (info.final !== undefined) tags["inferlo.final"] = String(info.final);
    if (info.requestId) tags.request_id = info.requestId;
    if (info.tenantId) tags.tenant_id = info.tenantId;
    if (info.traceId) tags.trace_id = info.traceId;
    const context: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(info)) if (value !== undefined) context[key] = value;
    sentry.captureException(error, { tags, contexts: { inferlo: context }, ...(info.userId ? { user: { id: info.userId } } : {}) });
  };
}
