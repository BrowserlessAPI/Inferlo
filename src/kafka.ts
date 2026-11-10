/**
 * Events between services over Apache Kafka, without a runtime dependency on a Kafka client:
 *
 *   import { KafkaJS } from "@confluentinc/kafka-javascript";
 *   import { kafkaEventTransport } from "@browserlessapi/inferlo/kafka";
 *
 *   const kafka = new KafkaJS.Kafka({ kafkaJS: { brokers: process.env.KAFKA_BROKERS!.split(",") } });
 *   export const app = createApp({ name: "billing", jobs, events: { transport: kafkaEventTransport(kafka, { service: "billing" }) } });
 *
 * Each event name has its own topic, "inferlo.events.<event name>" (created with the broker's defaults the first time
 * it is used). Published events are produced with the event id as key and send() resolves when the brokers
 * acknowledged them (acks from all in-sync replicas). Each service reads the topics of the events it subscribes to as
 * its own consumer group, "inferlo.<service>", so every subscribed service gets each event and its instances share the
 * partitions. An event's offset is committed after its jobs are queued; one that fails is delivered again after
 * staleAfterMs, holding the events behind it on that partition. Delivery is at least once (an instance that stops
 * before its offsets were committed hands them to another one); the jobs it queues have ids derived from the event id,
 * so a repeated delivery queues nothing new. app.close() disconnects the producer and consumer the transport created.
 */
import { InferloError } from "./errors.ts";
import type { EventMessage, EventTransport } from "./events.ts";

/** A message given to eachMessage: the parts Inferlo uses. */
export interface KafkaMessage {
  value: Uint8Array | string | null;
  offset: string;
}

/** The parts of a KafkaJS-style producer that Inferlo uses. */
export interface KafkaProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: { topic: string; messages: { key: string; value: string; headers?: Record<string, string> }[] }): Promise<unknown>;
}

/** The parts of a KafkaJS-style consumer that Inferlo uses. */
export interface KafkaConsumer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(subscription: { topics: string[] }): Promise<void>;
  run(config: { eachMessage: (payload: { topic: string; partition: number; message: KafkaMessage }) => Promise<void> }): Promise<void>;
}

/** The parts of a KafkaJS-style admin client that Inferlo uses. */
export interface KafkaAdmin {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createTopics(options: { topics: { topic: string; numPartitions?: number }[] }): Promise<boolean>;
}

/** new KafkaJS.Kafka({ kafkaJS: { brokers } }) from @confluentinc/kafka-javascript (1.0.0 or later). */
export interface KafkaClient {
  producer(config?: object): KafkaProducer;
  consumer(config: object): KafkaConsumer;
  admin(config?: object): KafkaAdmin;
}

export interface KafkaEventTransportOptions {
  /**
   * This service's name, usually the same as createApp({ name }). Each service reads every event it subscribes to
   * once, as the consumer group "inferlo.<service>"; its instances share the topics' partitions.
   */
  service: string;
  /** Topic names are this prefix and the event name. Default "inferlo.events.". Every service must use the same one. */
  topicPrefix?: string;
  /** Partitions of the topics this transport creates (at most as many instances read one event at once). Default: the broker's default. */
  partitions?: number;
  /**
   * Where a new consumer group starts: false (default) reads events published after this service first joined,
   * true reads every event still in the topics. Groups that already committed offsets continue from them.
   */
  fromBeginning?: boolean;
  /** An event whose delivery failed (its jobs could not be queued) is delivered again after this long. Default 30000. */
  staleAfterMs?: number;
  /** Events delivered per receive() call. Default 100. */
  batch?: number;
}

const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const PREFIX = /^[A-Za-z0-9._-]{0,100}$/;
const OPTION_KEYS = new Set(["service", "topicPrefix", "partitions", "fromBeginning", "staleAfterMs", "batch"]);

function invalid(why: string): InferloError {
  return new InferloError("IL6072", `Invalid kafkaEventTransport() arguments: ${why}.`, {
    fix: 'Pass a Kafka client and this service\'s name: kafkaEventTransport(new KafkaJS.Kafka({ kafkaJS: { brokers: ["kafka:9092"] } }), { service: "billing" }) with KafkaJS from "@confluentinc/kafka-javascript", then createApp({ name: "billing", events: { transport } }).',
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

const decoder = new TextDecoder();

/** An event read by the consumer, waiting for receive() to deliver it. */
interface Waiting {
  message: EventMessage;
  settle(error?: unknown): void;
}

export function kafkaEventTransport(kafka: KafkaClient, options: KafkaEventTransportOptions): EventTransport & { close(): Promise<void> } {
  const k = kafka as unknown as Record<string, unknown> | null | undefined;
  if (!k || typeof k !== "object" || typeof k.producer !== "function" || typeof k.consumer !== "function" || typeof k.admin !== "function") {
    throw invalid('the first argument must be a Kafka client: new KafkaJS.Kafka({ kafkaJS: { brokers } }) with KafkaJS from "@confluentinc/kafka-javascript"');
  }
  if (!options || typeof options !== "object") throw invalid('pass the options, at least { service: "billing" }');
  for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) throw invalid(`unknown option "${key}"`);
  if (typeof options.service !== "string" || !NAME.test(options.service)) throw invalid(`service must be 1 to 100 letters, digits, "-" and "_", got ${JSON.stringify(options.service)}`);
  const prefix = options.topicPrefix ?? "inferlo.events.";
  if (typeof prefix !== "string" || !PREFIX.test(prefix) || prefix.startsWith("__")) throw invalid(`topicPrefix must be up to 100 letters, digits, ".", "-" and "_", not starting with "__", got ${JSON.stringify(options.topicPrefix)}`);
  if (options.fromBeginning !== undefined && typeof options.fromBeginning !== "boolean") throw invalid("fromBeginning must be true or false");
  const whole = (name: string, value: number | undefined, fallback: number | undefined, min: number, max: number) => {
    const n = value ?? fallback;
    if (n === undefined) return undefined;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const partitions = whole("partitions", options.partitions, undefined, 1, 10_000);
  const staleAfterMs = whole("staleAfterMs", options.staleAfterMs, 30_000, 1000, 3_600_000)!;
  const batch = whole("batch", options.batch, 100, 1, 1000)!;
  const groupId = `inferlo.${options.service}`;
  const topicFor = (name: string) => `${prefix}${name}`;

  let closed = false;
  const created = new Set<string>();
  let admin: Promise<KafkaAdmin> | undefined;
  let producer: Promise<KafkaProducer> | undefined;
  let consumer: Promise<KafkaConsumer> | undefined;
  /** Connects a client once; a failed connect is tried again on the next call. */
  const once = <C extends { connect(): Promise<void> }>(make: () => C, reset: () => void) =>
    (async () => {
      const client = make();
      await client.connect();
      return client;
    })().catch((error: unknown) => {
      reset();
      throw error;
    });

  /** Creates the topics that do not exist yet (createTopics leaves existing ones alone). */
  const ensureTopics = async (names: readonly string[]) => {
    const topics = names.map(topicFor).filter((t) => !created.has(t));
    if (!topics.length) return;
    const client = await (admin ??= once(() => kafka.admin(), () => (admin = undefined)));
    await client.createTopics({ topics: topics.map((topic) => (partitions ? { topic, numPartitions: partitions } : { topic })) });
    for (const t of topics) created.add(t);
  };

  // Events the consumer read, in order, and receive() calls waiting for the next one.
  const waiting: Waiting[] = [];
  let wake: (() => void) | undefined;
  const pending = new Set<(error: unknown) => void>();

  const parse = (topic: string, value: KafkaMessage["value"]): EventMessage | undefined => {
    if (!topic.startsWith(prefix) || value === null || value === undefined) return undefined;
    let body: Body;
    try {
      body = JSON.parse(typeof value === "string" ? value : decoder.decode(value)) as Body;
    } catch {
      return undefined;
    }
    if (!body || typeof body !== "object" || typeof body.id !== "string" || !body.id || !("payload" in body)) return undefined;
    const at = new Date(typeof body.publishedAt === "string" ? body.publishedAt : Number.NaN);
    const traceparent = typeof body.traceparent === "string" ? body.traceparent : undefined;
    const tracestate = typeof body.tracestate === "string" ? body.tracestate : undefined;
    return {
      id: body.id,
      name: topic.slice(prefix.length),
      payload: body.payload,
      publishedAt: Number.isNaN(at.getTime()) ? new Date() : at,
      ...(traceparent ? { trace: { traceparent, ...(tracestate ? { tracestate } : {}) } } : {}),
      ...(typeof body.tenantId === "string" && body.tenantId ? { tenantId: body.tenantId } : {}),
    };
  };

  /** Hands one event to receive() until it is delivered; the offset is committed once this resolves. */
  const handle = async (message: EventMessage) => {
    while (true) {
      if (closed) throw new Error("kafkaEventTransport closed"); // not committed: read again after a restart
      const error = await new Promise<unknown>((resolve, reject) => {
        const fail = (e: unknown) => {
          pending.delete(fail);
          reject(e);
        };
        pending.add(fail);
        waiting.push({
          message,
          settle: (e) => {
            pending.delete(fail);
            resolve(e);
          },
        });
        wake?.();
      });
      if (error === undefined) return;
      if (closed) throw error;
      // Delivery failed (a dependency is down): wait, then try the same event again; the partition waits with it.
      await new Promise<void>((resolve, reject) => {
        const fail = (e: unknown) => {
          clearTimeout(timer);
          pending.delete(fail);
          reject(e);
        };
        const timer = setTimeout(() => {
          pending.delete(fail);
          resolve();
        }, staleAfterMs);
        pending.add(fail);
      });
    }
  };

  const startConsumer = (names: readonly string[]) =>
    once(
      () => kafka.consumer({ kafkaJS: { groupId, fromBeginning: options.fromBeginning ?? false } }),
      () => (consumer = undefined),
    ).then(async (client) => {
      try {
        await ensureTopics(names);
        await client.subscribe({ topics: names.map(topicFor) });
        await client.run({
          eachMessage: async ({ topic, message }) => {
            const event = parse(topic, message.value);
            if (event) await handle(event); // anything else is not an Inferlo event: skipped and committed
          },
        });
        return client;
      } catch (error) {
        consumer = undefined;
        await client.disconnect().catch(() => {});
        throw error;
      }
    });

  return {
    name: "kafka",

    async send(message) {
      if (closed) throw new Error("kafkaEventTransport is closed: app.close() was called");
      await ensureTopics([message.name]);
      const client = await (producer ??= once(() => kafka.producer(), () => (producer = undefined)));
      const body: Body = { id: message.id, payload: message.payload ?? null, publishedAt: message.publishedAt.toISOString() };
      if (message.tenantId) body.tenantId = message.tenantId;
      if (message.trace?.traceparent) body.traceparent = message.trace.traceparent;
      if (message.trace?.tracestate) body.tracestate = message.trace.tracestate;
      await client.send({ topic: topicFor(message.name), messages: [{ key: message.id, value: JSON.stringify(body), headers: { "content-type": "application/json" } }] });
    },

    async receive(names, deliver) {
      if (closed || !names.length) return 0;
      // The consumer joins its group in the background; events arrive in later calls.
      await (consumer ??= startConsumer(names));
      let delivered = 0;
      while (delivered < batch) {
        let next = waiting.shift();
        if (!next) {
          if (!delivered) return 0;
          // The consumer reads the next event as soon as the last one is settled: wait for it briefly.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 20);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
          next = waiting.shift();
          if (!next) break;
        }
        try {
          await deliver(next.message);
        } catch (error) {
          next.settle(error);
          throw error;
        }
        next.settle();
        delivered++;
      }
      return delivered;
    },

    async close() {
      if (closed) return;
      closed = true;
      const stopped = new Error("kafkaEventTransport closed");
      for (const fail of [...pending]) fail(stopped);
      for (const w of waiting.splice(0)) w.settle(stopped);
      const clients = await Promise.all([consumer, producer, admin].map((c) => c?.catch(() => undefined)));
      await Promise.all(clients.map((c) => c?.disconnect().catch(() => {})));
    },
  };
}
