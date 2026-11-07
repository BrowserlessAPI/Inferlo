/**
 * Events between services over NATS JetStream:
 *
 *   import { connect } from "@nats-io/transport-node";
 *   import { natsEventTransport } from "@browserlessapi/inferlo/nats";
 *
 *   const nc = await connect({ servers: process.env.NATS_URL });
 *   export const app = createApp({ name: "billing", jobs, events: { transport: natsEventTransport(nc, { service: "billing" }) } });
 *
 * Published events go to the JetStream stream INFERLO_EVENTS (subjects inferlo.events.<event name>), created on
 * first use. Each service reads each event it subscribes to with its own durable pull consumer
 * (inferlo-<service>-<event name with "_" for ".">), so every subscribed service gets each event, and its instances
 * share the work. A message is
 * acknowledged after its jobs are queued; one that fails, or that an instance read but never acknowledged (it
 * stopped), is delivered again after staleAfterMs. Delivery is at least once; the jobs it queues have ids derived
 * from the event id, so a repeated delivery queues nothing new. Publishing sets Nats-Msg-Id to the event id, so
 * JetStream drops a repeated publish within its duplicate window.
 *
 * @nats-io/jetstream is an optional peer dependency, loaded by this entry point only.
 */
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, type JetStreamManager, type JsMsg } from "@nats-io/jetstream";
import { InferloError } from "./errors.ts";
import type { EventMessage, EventTransport } from "./events.ts";

/** The connection jetstream() takes: what connect() from @nats-io/transport-node (or another transport) returns. */
export type NatsConnection = Parameters<typeof jetstream>[0];

export interface NatsEventTransportOptions {
  /**
   * This service's name, usually the same as createApp({ name }). Each service reads every event it subscribes to
   * once, through its own durable consumers "inferlo-<service>-<event>"; its instances share them.
   */
  service: string;
  /** The JetStream stream for events (created when missing). Default "INFERLO_EVENTS". Every service must use the same one. */
  stream?: string;
  /** How long the stream keeps events when the stream is created, in milliseconds. Default 7 days. */
  maxAgeMs?: number;
  /** A message delivered but not acknowledged for this long (its instance stopped, or queueing failed) is delivered again. Default 30000. */
  staleAfterMs?: number;
  /** Messages read per receive() call. Default 100. */
  batch?: number;
}

export const NATS_SUBJECT_PREFIX = "inferlo.events.";
const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const OPTION_KEYS = new Set(["service", "stream", "maxAgeMs", "staleAfterMs", "batch"]);
const ms = (value: number) => value * 1_000_000; // JetStream durations are nanoseconds

function invalid(why: string): InferloError {
  return new InferloError("IL6051", `Invalid natsEventTransport() arguments: ${why}.`, {
    fix: 'Pass a NATS connection and this service\'s name: natsEventTransport(await connect({ servers: process.env.NATS_URL }), { service: "billing" }), then createApp({ name: "billing", events: { transport } }).',
  });
}

function isMissing(error: unknown): boolean {
  const e = error as { code?: unknown; api_error?: { err_code?: number }; message?: string } | null;
  return e?.api_error?.err_code === 10059 || e?.api_error?.err_code === 10014 || /not found/i.test(String(e?.message ?? ""));
}

interface Body {
  id?: unknown;
  payload?: unknown;
  publishedAt?: unknown;
  tenantId?: unknown;
  traceparent?: unknown;
  tracestate?: unknown;
}

export function natsEventTransport(connection: NatsConnection, options: NatsEventTransportOptions): EventTransport {
  if (!connection || typeof connection !== "object" || typeof (connection as { publish?: unknown }).publish !== "function" || typeof (connection as { request?: unknown }).request !== "function") {
    throw invalid("the first argument must be a connected NATS connection (connect() from @nats-io/transport-node)");
  }
  if (!options || typeof options !== "object") throw invalid('pass the options, at least { service: "billing" }');
  for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw invalid(`unknown option "${key}"`);
  if (typeof options.service !== "string" || !NAME.test(options.service)) throw invalid(`service must be 1 to 100 letters, digits, "-" and "_", got ${JSON.stringify(options.service)}`);
  const streamName = options.stream ?? "INFERLO_EVENTS";
  if (typeof streamName !== "string" || !NAME.test(streamName)) throw invalid(`stream must be 1 to 100 letters, digits, "-" and "_", got ${JSON.stringify(options.stream)}`);
  const whole = (name: string, value: number | undefined, fallback: number, min: number, max: number) => {
    const n = value ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const maxAgeMs = whole("maxAgeMs", options.maxAgeMs, 7 * 24 * 60 * 60_000, 60_000, 365 * 24 * 60 * 60_000);
  const staleAfterMs = whole("staleAfterMs", options.staleAfterMs, 30_000, 1000, 3_600_000);
  const batch = whole("batch", options.batch, 100, 1, 1000);
  let client: ReturnType<typeof jetstream> | undefined;
  const js = () => (client ??= jetstream(connection));
  let manager: Promise<JetStreamManager> | undefined;
  let streamReady: Promise<void> | undefined;
  const ready = new Set<string>();
  const subject = (name: string) => `${NATS_SUBJECT_PREFIX}${name}`;

  const jsm = () => (manager ??= jetstreamManager(connection).catch((error: unknown) => {
    manager = undefined;
    throw error;
  }));

  /** Creates the stream on first use (it is shared by every service and kept when it exists). */
  const ensureStream = () =>
    (streamReady ??= (async () => {
      const m = await jsm();
      try {
        await m.streams.info(streamName);
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          await m.streams.add({ name: streamName, subjects: [`${NATS_SUBJECT_PREFIX}>`], max_age: ms(maxAgeMs), duplicate_window: ms(120_000) });
        } catch (addError) {
          // Another service created it at the same moment.
          await m.streams.info(streamName).catch(() => {
            throw addError;
          });
        }
      }
    })().catch((error: unknown) => {
      streamReady = undefined;
      throw error;
    }));

  /** The durable consumer of this service for one event, like a Redis consumer group per stream. */
  const durableFor = (name: string) => `inferlo-${options.service}-${name.replaceAll(".", "_")}`;

  /** Creates this service's consumer for an event the first time this instance reads it. */
  const ensureConsumer = async (name: string) => {
    if (ready.has(name)) return;
    await ensureStream();
    const m = await jsm();
    const durable = durableFor(name);
    try {
      await m.consumers.info(streamName, durable);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // A service starts with the events published from its first read on, like a Redis consumer group created at "$".
      await m.consumers.add(streamName, { durable_name: durable, filter_subject: subject(name), ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.New, ack_wait: ms(staleAfterMs), max_ack_pending: Math.max(1000, batch) });
    }
    ready.add(name);
  };

  const parse = (msg: JsMsg): EventMessage | undefined => {
    if (!msg.subject.startsWith(NATS_SUBJECT_PREFIX)) return undefined;
    let body: Body;
    try {
      body = msg.json<Body>();
    } catch {
      return undefined;
    }
    if (!body || typeof body !== "object" || typeof body.id !== "string" || !body.id || !("payload" in body)) return undefined;
    const at = new Date(typeof body.publishedAt === "string" ? body.publishedAt : Number.NaN);
    const traceparent = typeof body.traceparent === "string" ? body.traceparent : undefined;
    const tracestate = typeof body.tracestate === "string" ? body.tracestate : undefined;
    return {
      id: body.id,
      name: msg.subject.slice(NATS_SUBJECT_PREFIX.length),
      payload: body.payload,
      publishedAt: Number.isNaN(at.getTime()) ? new Date() : at,
      ...(traceparent ? { trace: { traceparent, ...(tracestate ? { tracestate } : {}) } } : {}),
      ...(typeof body.tenantId === "string" && body.tenantId ? { tenantId: body.tenantId } : {}),
    };
  };

  return {
    name: "nats",

    async send(message) {
      await ensureStream();
      const body: Body = { id: message.id, payload: message.payload ?? null, publishedAt: message.publishedAt.toISOString() };
      if (message.tenantId) body.tenantId = message.tenantId;
      if (message.trace?.traceparent) body.traceparent = message.trace.traceparent;
      if (message.trace?.tracestate) body.tracestate = message.trace.tracestate;
      await js().publish(subject(message.name), JSON.stringify(body), { msgID: message.id });
    },

    async receive(names, deliver) {
      let delivered = 0;
      let failure: unknown;
      for (const name of names) {
        try {
          await ensureConsumer(name);
          const consumer = await js().consumers.get(streamName, durableFor(name));
          // A pull request waits until it has max_messages or expires (at least 1 s), so ask for what is waiting:
          // new messages, plus delivered ones that may be due again.
          const info = await consumer.info(true);
          const waiting = Math.min(batch, info.num_pending + info.num_ack_pending);
          if (waiting === 0) continue;
          const messages = await consumer.fetch({ max_messages: waiting, expires: 1000 });
          for await (const msg of messages) {
            const message = parse(msg);
            if (!message) {
              msg.term(); // not an Inferlo event: never deliver it again
              continue;
            }
            try {
              await deliver(message);
            } catch (error) {
              failure ??= error;
              msg.nak(staleAfterMs);
              continue;
            }
            await msg.ackAck().catch(() => false); // a lost ack means one more delivery, which queues nothing new
            delivered++;
          }
        } catch (error) {
          ready.delete(name); // the consumer or the stream was deleted: create them again on the next call
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      return delivered;
    },
  };
}
