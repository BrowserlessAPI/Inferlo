/**
 * Events between services over RabbitMQ, without a runtime dependency on amqplib:
 *
 *   import amqp from "amqplib";
 *   import { rabbitmqEventTransport } from "@browserlessapi/inferlo/rabbitmq";
 *
 *   const connection = await amqp.connect(process.env.RABBITMQ_URL);
 *   export const app = createApp({ name: "billing", jobs, events: { transport: rabbitmqEventTransport(connection, { service: "billing" }) } });
 *
 * Published events go to the durable topic exchange "inferlo.events" with the event name as routing key, as
 * persistent messages, and send() resolves when RabbitMQ confirmed them (publisher confirms). Each service reads each
 * event it subscribes to from its own durable queue "inferlo.<service>.<event name>" (a quorum queue by default),
 * bound to the exchange the first time an instance reads it, so every subscribed service gets each event and its
 * instances share the work. A message is acknowledged after its jobs are queued; one that fails is returned to its
 * queue after staleAfterMs, and the messages of an instance that stopped are returned when its channel closes.
 * Delivery is at least once; the jobs it queues have ids derived from the event id, so a repeated delivery queues
 * nothing new.
 */
import { InferloError } from "./errors.ts";
import type { EventMessage, EventTransport } from "./events.ts";

/** A message read with channel.get(): the parts Inferlo uses. */
export interface AmqpMessage {
  content: Uint8Array;
  fields: { routingKey: string; deliveryTag?: number };
  properties: { messageId?: string; [key: string]: unknown };
}

/** The parts of an amqplib channel (promise API) that Inferlo uses. */
export interface AmqpChannel {
  assertExchange(exchange: string, type: string, options?: object): Promise<unknown>;
  assertQueue(queue: string, options?: object): Promise<unknown>;
  bindQueue(queue: string, exchange: string, pattern: string): Promise<unknown>;
  get(queue: string, options?: { noAck?: boolean }): Promise<AmqpMessage | false>;
  ack(message: AmqpMessage): void;
  nack(message: AmqpMessage, allUpTo?: boolean, requeue?: boolean): void;
  close(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** A confirm channel: publish() calls back when RabbitMQ confirmed the message. */
export interface AmqpConfirmChannel extends AmqpChannel {
  publish(exchange: string, routingKey: string, content: Uint8Array, options: object, callback: (error: unknown) => void): boolean;
}

/** What connect() from amqplib (promise API, 0.10.9 and later) returns. */
export interface AmqpConnection {
  createChannel(): Promise<AmqpChannel>;
  createConfirmChannel(): Promise<AmqpConfirmChannel>;
}

export interface RabbitmqEventTransportOptions {
  /**
   * This service's name, usually the same as createApp({ name }). Each service reads every event it subscribes to
   * once, from its own queues "inferlo.<service>.<event>"; its instances share them.
   */
  service: string;
  /** The topic exchange events are published to (declared durable when missing). Default "inferlo.events". Every service must use the same one. */
  exchange?: string;
  /**
   * The type of the queues this service declares: "quorum" (default, replicated across the cluster's nodes) or
   * "classic". RabbitMQ 4 drops a message from a quorum queue after 20 deliveries by default (with staleAfterMs
   * 30000, about 10 minutes of failed deliveries); set a "delivery-limit" or dead-letter policy for the
   * "inferlo." queues to change that.
   */
  queueType?: "quorum" | "classic";
  /** A message whose delivery failed (its jobs could not be queued) is returned to the queue after this long. Default 30000. */
  staleAfterMs?: number;
  /** Messages read per event and receive() call. Default 100. */
  batch?: number;
}

const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const EXCHANGE = /^[A-Za-z0-9._-]{1,200}$/;
const OPTION_KEYS = new Set(["service", "exchange", "queueType", "staleAfterMs", "batch"]);

function invalid(why: string): InferloError {
  return new InferloError("IL6054", `Invalid rabbitmqEventTransport() arguments: ${why}.`, {
    fix: 'Pass an amqplib connection and this service\'s name: rabbitmqEventTransport(await amqp.connect(process.env.RABBITMQ_URL), { service: "billing" }), then createApp({ name: "billing", events: { transport } }).',
  });
}

interface Body {
  id?: unknown;
  payload?: unknown;
  publishedAt?: unknown;
  tenantId?: unknown;
  traceparent?: unknown;
  tracestate?: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** amqplib takes Node.js Buffers, which Node.js, Bun and Deno all have. */
function bytes(text: string): Uint8Array {
  const NodeBuffer = (globalThis as { Buffer?: { from(input: Uint8Array): Uint8Array } }).Buffer;
  const encoded = encoder.encode(text);
  return NodeBuffer ? NodeBuffer.from(encoded) : encoded;
}

export function rabbitmqEventTransport(connection: AmqpConnection, options: RabbitmqEventTransportOptions): EventTransport {
  const c = connection as unknown as Record<string, unknown> | null | undefined;
  if (!c || typeof c !== "object" || typeof c.createChannel !== "function" || typeof c.createConfirmChannel !== "function") {
    throw invalid("the first argument must be a connection from amqplib's connect() (the promise API, import amqp from \"amqplib\")");
  }
  if (!options || typeof options !== "object") throw invalid('pass the options, at least { service: "billing" }');
  for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw invalid(`unknown option "${key}"`);
  if (typeof options.service !== "string" || !NAME.test(options.service)) throw invalid(`service must be 1 to 100 letters, digits, "-" and "_", got ${JSON.stringify(options.service)}`);
  const exchange = options.exchange ?? "inferlo.events";
  if (typeof exchange !== "string" || !EXCHANGE.test(exchange) || exchange.startsWith("amq.")) throw invalid(`exchange must be 1 to 200 letters, digits, ".", "-" and "_", not starting with "amq.", got ${JSON.stringify(options.exchange)}`);
  const queueType = options.queueType ?? "quorum";
  if (queueType !== "quorum" && queueType !== "classic") throw invalid(`queueType must be "quorum" or "classic", got ${JSON.stringify(options.queueType)}`);
  const whole = (name: string, value: number | undefined, fallback: number, min: number, max: number) => {
    const n = value ?? fallback;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const staleAfterMs = whole("staleAfterMs", options.staleAfterMs, 30_000, 1000, 3_600_000);
  const batch = whole("batch", options.batch, 100, 1, 1000);
  const service = options.service;

  /** Opens a channel on first use and again after it closed (a channel error closes it). */
  function lazyChannel<C extends AmqpChannel>(open: () => Promise<C>): { get(): Promise<C>; isCurrent(channel: C): boolean } {
    let current: Promise<C> | undefined;
    let opened: C | undefined;
    return {
      get: () =>
        (current ??= (async () => {
          const channel = await open();
          opened = channel;
          const reset = () => {
            if (opened === channel) {
              current = undefined;
              opened = undefined;
            }
          };
          channel.on("close", reset);
          channel.on("error", reset); // the error also rejects the operation that caused it; without a listener it would crash the process
          await channel.assertExchange(exchange, "topic", { durable: true });
          return channel;
        })().catch((error: unknown) => {
          current = undefined;
          throw error;
        })),
      isCurrent: (channel) => opened === channel,
    };
  }

  const publisher = lazyChannel(() => connection.createConfirmChannel());
  const reader = lazyChannel(() => connection.createChannel());
  const bound = new Set<string>();
  const queueFor = (name: string) => `inferlo.${service}.${name}`;

  /** Declares this service's queue for an event and binds it, the first time this instance reads the event. */
  const ensureQueue = async (channel: AmqpChannel, name: string) => {
    if (bound.has(name)) return;
    const queue = queueFor(name);
    await channel.assertQueue(queue, { durable: true, arguments: queueType === "quorum" ? { "x-queue-type": "quorum" } : { "x-queue-type": "classic" } });
    await channel.bindQueue(queue, exchange, name);
    bound.add(name);
  };

  const parse = (msg: AmqpMessage): EventMessage | undefined => {
    let body: Body;
    try {
      body = JSON.parse(decoder.decode(msg.content)) as Body;
    } catch {
      return undefined;
    }
    if (!body || typeof body !== "object" || typeof body.id !== "string" || !body.id || !("payload" in body)) return undefined;
    const at = new Date(typeof body.publishedAt === "string" ? body.publishedAt : Number.NaN);
    const traceparent = typeof body.traceparent === "string" ? body.traceparent : undefined;
    const tracestate = typeof body.tracestate === "string" ? body.tracestate : undefined;
    return {
      id: body.id,
      name: msg.fields.routingKey,
      payload: body.payload,
      publishedAt: Number.isNaN(at.getTime()) ? new Date() : at,
      ...(traceparent ? { trace: { traceparent, ...(tracestate ? { tracestate } : {}) } } : {}),
      ...(typeof body.tenantId === "string" && body.tenantId ? { tenantId: body.tenantId } : {}),
    };
  };

  return {
    name: "rabbitmq",

    async send(message) {
      const channel = await publisher.get();
      const body: Body = { id: message.id, payload: message.payload ?? null, publishedAt: message.publishedAt.toISOString() };
      if (message.tenantId) body.tenantId = message.tenantId;
      if (message.trace?.traceparent) body.traceparent = message.trace.traceparent;
      if (message.trace?.tracestate) body.tracestate = message.trace.tracestate;
      await new Promise<void>((resolve, reject) => {
        try {
          channel.publish(
            exchange,
            message.name,
            bytes(JSON.stringify(body)),
            { persistent: true, messageId: message.id, contentType: "application/json", timestamp: Math.floor(message.publishedAt.getTime() / 1000) },
            (error) => (error ? reject(error instanceof Error ? error : new Error(`RabbitMQ did not confirm event "${message.name}" (${message.id})`)) : resolve()),
          );
        } catch (error) {
          reject(error); // the channel closed
        }
      });
    },

    async receive(names, deliver) {
      let delivered = 0;
      let failure: unknown;
      for (const name of names) {
        try {
          const channel = await reader.get();
          await ensureQueue(channel, name);
          for (let i = 0; i < batch; i++) {
            const msg = await channel.get(queueFor(name), { noAck: false });
            if (!msg) break;
            const message = parse(msg);
            if (!message || message.name !== name) {
              channel.ack(msg); // not an Inferlo event: never deliver it again
              continue;
            }
            try {
              await deliver(message);
            } catch (error) {
              failure ??= error;
              // Hold the message, then return it to the queue, so a failing dependency is retried every staleAfterMs.
              const timer = setTimeout(() => {
                try {
                  if (reader.isCurrent(channel)) channel.nack(msg, false, true);
                } catch {
                  // the channel closed, which returned the message already
                }
              }, staleAfterMs);
              (timer as { unref?: () => void }).unref?.();
              break;
            }
            channel.ack(msg); // a lost ack means one more delivery, which queues nothing new
            delivered++;
          }
        } catch (error) {
          bound.delete(name); // the queue was deleted or the channel closed: declare it again on the next call
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      return delivered;
    },
  };
}
