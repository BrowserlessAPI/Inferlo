/**
 * Events: something that happened, published once and handled by any number of jobs.
 *
 *   export const orderPaid = event("order.paid", { payload: t.object({ orderId: t.uuid(), amount: t.int() }) });
 *   export const sendReceipt = job("send-receipt", { input: orderPaid.payload }).handle(async ({ input }) => { ... });
 *
 *   createApp({ jobs: [on(orderPaid, sendReceipt), on(orderPaid, addPoints)] })
 *   await ctx.events.publish(orderPaid, { orderId, amount });   // in a route handler or job, validated
 *
 * An event is delivered through the job queue: publishing queues every subscribed job with the payload, so
 * retries, the memory, database and Redis stores, the worker and tracing work as for any job. The queued jobs get
 * ids derived from the event id, so publishing the same event id again (a repeated delivery) queues nothing new.
 */
import { InferloError } from "./errors.ts";
import type { JobDef, JobInput } from "./jobs.ts";
import { ValidationError, type AnySchema, type Infer, type InferInput } from "./schema.ts";

export interface EventOptions<P extends AnySchema> {
  /** Schema of the payload. Checked when the event is published. */
  payload: P;
  /** One line shown in describe. */
  summary?: string;
}

export interface EventDef<Input = any, Payload = any, S extends AnySchema = AnySchema> {
  readonly kind: "inferlo.event";
  /** Lowercase words separated by dots: "order.paid". */
  readonly name: string;
  /** The payload schema, also usable as a subscribed job's input: job("send-receipt", { input: orderPaid.payload }). */
  readonly payload: S;
  readonly summary?: string;
  /** Type only: what publish accepts. */
  readonly $input?: Input;
  /** Type only: the payload after validation, which subscribed jobs receive. */
  readonly $payload?: Payload;
}

/** What publish accepts for an event. */
export type EventPayload<E> = E extends EventDef<infer I, any, any> ? I : never;

/** A subscription: on(event, job) in createApp({ jobs }) queues the job with the payload of every published event. */
export interface OnDef<E extends EventDef = EventDef, J extends JobDef = JobDef> {
  readonly kind: "inferlo.on";
  readonly event: E;
  readonly job: J;
}

export interface PublishOptions {
  /** The event id. Default: a new UUID. Publishing the same id again queues no job twice (for outboxes and redelivery). */
  id?: string;
}

export interface PublishedEvent {
  id: string;
  name: string;
  publishedAt: Date;
  /** Ids of the jobs queued for it, one per subscription in this app. */
  jobs: string[];
}

export interface Events {
  /** Validate the payload and queue every job subscribed to the event with on(event, job). */
  publish<E extends EventDef>(event: E, payload: EventPayload<E>, options?: PublishOptions): Promise<PublishedEvent>;
}

/** app.events: publish events and see the subscriptions. */
export interface AppEvents extends Events {
  /** Events with at least one subscription in this app, in the order they were registered. */
  readonly list: readonly EventDef[];
  /** The subscriptions: on(event, job) values in createApp({ jobs }) and in modules. */
  readonly subscriptions: readonly OnDef[];
}

const EVENT_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const FIX = 'Use event("order.paid", { payload: t.object({ orderId: t.uuid() }) }) and subscribe jobs in createApp({ jobs: [on(orderPaid, sendReceipt)] }).';

function invalid(message: string, fix = FIX): InferloError {
  return new InferloError("IL6032", message, { fix });
}

/** Define an event: event("order.paid", { payload: t.object({ ... }) }). */
export function event<P extends AnySchema>(name: string, options: EventOptions<P>): EventDef<InferInput<P>, Infer<P>, P> {
  if (typeof name !== "string" || name.length > 100 || !EVENT_NAME.test(name)) {
    throw invalid(`Invalid event name ${JSON.stringify(name)}: the name must be lowercase words of letters, digits and dashes, separated by dots, such as "order.paid".`);
  }
  if (!options || typeof options !== "object" || !options.payload || typeof (options.payload as AnySchema).safeParse !== "function") {
    throw invalid(`Invalid event "${name}": it needs a payload schema such as t.object({ ... }).`);
  }
  for (const key of Object.keys(options)) {
    if (key !== "payload" && key !== "summary") throw invalid(`Invalid event "${name}": unknown option "${key}". An event takes payload and summary; retries belong to the subscribed jobs.`);
  }
  if (options.summary !== undefined && typeof options.summary !== "string") throw invalid(`Invalid event "${name}": summary must be a string.`);
  const def: EventDef<InferInput<P>, Infer<P>, P> = { kind: "inferlo.event", name, payload: options.payload, ...(options.summary ? { summary: options.summary } : {}) };
  return Object.freeze(def);
}

export function isEvent(value: unknown): value is EventDef {
  return typeof value === "object" && value !== null && (value as EventDef).kind === "inferlo.event";
}

export function isOn(value: unknown): value is OnDef {
  return typeof value === "object" && value !== null && (value as OnDef).kind === "inferlo.on";
}

type Properties = { properties?: Record<string, unknown>; required?: string[]; type?: unknown };

/**
 * Subscribe a job to an event: on(orderPaid, sendReceipt) in createApp({ jobs }). Every published event queues the
 * job with the payload as its input (use input: orderPaid.payload); a job whose input is an object with fewer fields
 * gets only those fields.
 */
export function on<E extends EventDef, J extends JobDef>(event: E, job: J & (NonNullable<E["$payload"]> extends JobInput<J> ? unknown : never)): OnDef<E, J> {
  if (!isEvent(event)) throw invalid("on() needs an event made with event(name, { payload }) as its first argument.");
  const j = job as JobDef;
  if (typeof j !== "object" || j === null || j.kind !== "inferlo.job") throw invalid(`on("${event.name}") needs a job made with job(name, { input }).handle(fn) as its second argument.`);
  // The payload must have every field the job requires (checked on the JSON Schemas; publish validates again).
  const payload = event.payload.toJSONSchema() as Properties;
  const input = j.options.input.toJSONSchema() as Properties;
  const missing = payload.type === "object" && input.type === "object" ? (input.required ?? []).filter((key) => !(key in (payload.properties ?? {}))) : [];
  if (missing.length) {
    throw invalid(
      `Job "${j.name}" cannot handle event "${event.name}": its input requires ${missing.map((k) => `"${k}"`).join(", ")}, which the payload does not have.`,
      `Use the event's payload as the job's input: job("${j.name}", { input: ${event.name.replace(/\W(\w)/g, (_, c: string) => c.toUpperCase())}.payload }).`,
    );
  }
  return Object.freeze({ kind: "inferlo.on", event, job: job as J });
}

/** Checks the subscriptions of an app: one definition per event name, and each job subscribed once per event. */
export function checkSubscriptions(subscriptions: readonly OnDef[]): EventDef[] {
  const events = new Map<string, EventDef>();
  const pairs = new Set<string>();
  for (const s of subscriptions) {
    const known = events.get(s.event.name);
    if (known && known !== s.event) {
      throw invalid(`Two different events are named "${s.event.name}".`, "Define each event once (export const orderPaid = event(...)) and import it wherever it is published or subscribed to.");
    }
    events.set(s.event.name, s.event);
    const pair = `${s.event.name}\u0000${s.job.name}`;
    if (pairs.has(pair)) throw invalid(`Job "${s.job.name}" is subscribed to event "${s.event.name}" twice.`, "Keep one on(event, job) for each pair.");
    pairs.add(pair);
  }
  return [...events.values()];
}

/** The id of the job queued for one subscription of one event: the same for the same event id, so it is queued once. */
export async function eventJobId(eventId: string, jobName: string): Promise<string> {
  const data = new TextEncoder().encode(`inferlo.event:${eventId}:${jobName}`);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8 (custom)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** app.events, built by createJobs: enqueue queues one job with a fixed id (returning its id). */
export function createEvents(subscriptions: readonly OnDef[], enqueue: (job: JobDef, input: unknown, id: string) => Promise<string>): AppEvents {
  const list = checkSubscriptions(subscriptions);
  // A job may take part of the payload (input: t.object({ orderId })): it gets only the fields its input has.
  const fields = new Map<OnDef, string[] | undefined>();
  for (const s of subscriptions) {
    const input = s.job.options.input.toJSONSchema() as Properties;
    fields.set(s, input.type === "object" && input.properties ? Object.keys(input.properties) : undefined);
  }
  const inputFor = (s: OnDef, payload: unknown): unknown => {
    const keys = fields.get(s);
    if (!keys || typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
    return Object.fromEntries(keys.filter((k) => k in payload).map((k) => [k, (payload as Record<string, unknown>)[k]]));
  };
  return {
    list,
    subscriptions,
    async publish(def, payload, options = {}) {
      if (!isEvent(def)) throw invalid("events.publish() needs an event made with event(name, { payload }).", "Pass the event and its payload: await events.publish(orderPaid, { orderId }).");
      if (options.id !== undefined && (typeof options.id !== "string" || options.id.length === 0 || options.id.length > 200)) {
        throw invalid(`The id for event "${def.name}" must be a non-empty string of at most 200 characters.`, "Leave it out for a new UUID, or pass the id of the record the event comes from (an outbox row).");
      }
      const parsed = def.payload.safeParse(payload);
      if (!parsed.ok) throw new ValidationError(parsed.issues, `payload for event "${def.name}"`);
      const id = options.id ?? crypto.randomUUID();
      const publishedAt = new Date();
      const jobs: string[] = [];
      for (const s of subscriptions) {
        if (s.event.name !== def.name) continue;
        jobs.push(await enqueue(s.job, inputFor(s, parsed.value), await eventJobId(id, s.job.name)));
      }
      return { id, name: def.name, publishedAt, jobs };
    },
  };
}
