/**
 * Audit log: who changed what, written explicitly from routes and jobs.
 *
 *   createApp({ models: [...models, AuditLog] })     // the audit_log table, created by migrations like any model
 *
 *   const ticket = await db.tickets.get(params.id);
 *   const updated = await db.tickets.update(ticket.id, body);
 *   await audit("tickets.update", { model: "tickets", before: ticket, after: updated });
 *
 * The entry records the signed-in user, the action, the record id, the changed fields ({ from, to }), the
 * request id and, in multi-tenant apps, the tenant. Secret fields (password, token, secret, API keys, hashes) are stored as "[redacted]".
 */
import { InferloError } from "./errors.ts";
import { model, type AnyModel } from "./model.ts";
import { REDACTED, type Redactor } from "./redact.ts";
import { t } from "./schema.ts";

/** One changed field: the value before and after (null when there was none). */
export interface AuditChange {
  from: unknown;
  to: unknown;
}

/** The audit_log table. Add it to createApp({ models }) (and to Register) to use ctx.audit. */
export const AuditLog = model("audit_log", {
  action: t.string().min(1).max(200).index().describe('What happened, such as "tickets.update"'),
  userId: t.string().max(200).optional().index().describe("Who did it: the signed-in user, or the userId passed by a job"),
  model: t.string().max(200).optional().describe('The changed record\'s model, such as "tickets"'),
  recordId: t.string().max(200).optional().index().describe("The changed record's id"),
  changes: t.json<Record<string, AuditChange | typeof REDACTED>>().optional().describe("Changed fields as { field: { from, to } }"),
  data: t.json<Record<string, unknown>>().optional().describe("Other details"),
  source: t.string().max(300).optional().describe('Where it was written: "GET /tickets/:id" or "job send-email"'),
  requestId: t.string().max(200).optional().describe("The request id (X-Request-Id) of the request that wrote it"),
  tenantId: t.string().max(200).optional().index().describe("The tenant (organisation) it happened in, in multi-tenant apps"),
});

/** What ctx.audit(action, entry) takes. Every field is optional. */
export interface AuditEntry {
  /** The changed record's model, such as "tickets". */
  model?: string;
  /** The changed record's id. Defaults to after.id or before.id. */
  recordId?: string;
  /** The record before the change (leave out for creates). */
  before?: object | null;
  /** The record after the change (leave out for deletes). */
  after?: object | null;
  /** Other details to keep with the entry. Secret fields are redacted. */
  data?: Record<string, unknown>;
  /**
   * Who did it. Routes use the signed-in user; jobs have no user, so pass the id of the user who asked for the
   * work. null records it as done by the system.
   */
  userId?: string | null;
  /**
   * The tenant (organisation) it happened in. Routes use the signed-in user's tenant and jobs the tenant they run
   * for; null records it without one.
   */
  tenantId?: string | null;
}

/** Writes one audit log entry: await ctx.audit("tickets.update", { model: "tickets", before, after }). */
export type Audit = (action: string, entry?: AuditEntry) => Promise<void>;

const SECRET_FIELD = /(password|passwd|secret|token|api[-_]?key|private[-_]?key|hash|cookie|authorization|session)/i;
const SKIP = new Set(["id", "createdAt", "updatedAt"]);

function plain(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** The fields that differ between before and after, as { field: { from, to } }, with secret fields redacted. */
export function auditChanges(before: object | null | undefined, after: object | null | undefined): Record<string, AuditChange | typeof REDACTED> {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  const out: Record<string, AuditChange | typeof REDACTED> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP.has(key)) continue;
    const from = plain(a[key]);
    const to = plain(b[key]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    out[key] = SECRET_FIELD.test(key) ? REDACTED : { from, to };
  }
  return out;
}

function redactData(data: Record<string, unknown>, redactor: Redactor): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) out[key] = SECRET_FIELD.test(key) && value !== undefined && value !== null ? REDACTED : value;
  return redactor.value(JSON.parse(JSON.stringify(out))) as Record<string, unknown>;
}

const fixMissing = "Add AuditLog to the app's models: createApp({ models: [...models, AuditLog] }), and to Register, then run inferlo db migrate.";

/** Builds ctx.audit for a route or a job. */
export function createAudit(
  models: readonly AnyModel[],
  redactor: Redactor,
  db: () => { audit_log?: { insert(row: Record<string, unknown>): Promise<unknown> } },
  defaults: { userId: string | null; tenantId?: string | null; source: string; requestId?: string },
): Audit {
  return async (action, entry = {}) => {
    if (!models.some((m) => m.name === AuditLog.name)) {
      throw new InferloError("IL6027", "ctx.audit() needs the AuditLog model in createApp({ models }).", { fix: fixMissing });
    }
    if (typeof action !== "string" || action.trim() === "") {
      throw new InferloError("IL6027", "ctx.audit(action) needs an action name, such as \"tickets.update\".", { fix: 'Call ctx.audit("tickets.update", { model: "tickets", before, after }).' });
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new InferloError("IL6027", "ctx.audit(action, entry) takes an object as entry.", { fix: 'Call ctx.audit("tickets.update", { model: "tickets", before, after }).' });
    }
    if (entry.tenantId !== undefined && entry.tenantId !== null && (typeof entry.tenantId !== "string" || entry.tenantId === "" || entry.tenantId.length > 200)) {
      throw new InferloError("IL6027", "ctx.audit(action, { tenantId }) takes a tenant id (a non-empty string of at most 200 characters) or null.", { fix: 'Leave tenantId out to record the current tenant, or pass the tenant\'s id: ctx.audit("plans.change", { tenantId: "acme" }).' });
    }
    const id = (entry.recordId ?? (entry.after as { id?: unknown } | null | undefined)?.id ?? (entry.before as { id?: unknown } | null | undefined)?.id) as unknown;
    const changes = entry.before || entry.after ? auditChanges(entry.before, entry.after) : undefined;
    const userId = entry.userId === undefined ? defaults.userId : entry.userId;
    const row: Record<string, unknown> = { action };
    if (userId !== null && userId !== undefined) row.userId = String(userId);
    if (entry.model !== undefined) row.model = entry.model;
    if (id !== undefined && id !== null) row.recordId = String(id);
    if (changes) row.changes = redactor.value(changes);
    if (entry.data !== undefined) row.data = redactData(entry.data, redactor);
    row.source = defaults.source;
    if (defaults.requestId) row.requestId = defaults.requestId;
    const tenantId = entry.tenantId === undefined ? defaults.tenantId : entry.tenantId;
    if (tenantId !== null && tenantId !== undefined) row.tenantId = tenantId;
    await db().audit_log!.insert(row);
  };
}
