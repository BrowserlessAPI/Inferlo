/**
 * ioredis as the Redis client of an Inferlo app, without a runtime dependency on ioredis:
 *
 *   import Redis from "ioredis";
 *   import { createApp } from "@browserlessapi/inferlo";
 *   import { ioredisClient, ioredisSubscriber } from "@browserlessapi/inferlo/ioredis";
 *
 *   const connection = new Redis(process.env.REDIS_URL);
 *   const app = createApp({
 *     name: "billing",
 *     redis: ioredisClient(connection),
 *     rateLimit: { store: "redis" },
 *     cache: { store: "redis" },
 *     jobQueue: { store: "redis" },
 *     sockets: { transport: "redis", subscriber: ioredisSubscriber(connection.duplicate()) },
 *   });
 *
 * ioredisClient sends Inferlo's commands with ioredis's call(command, ...args), so rate limits, the cache,
 * idempotency keys, the job queue, the Redis Streams event transport and the readiness check use the app's ioredis
 * connection (its reconnects, TLS and Sentinel settings apply; a keyPrefix raises IL6064, because Inferlo prefixes its own keys). ioredisSubscriber turns a second
 * connection into the subscriber that WebSocket broadcasts across instances need. Inferlo never closes either.
 */
import { InferloError } from "./errors.ts";
import type { RedisClient } from "./redis.ts";
import type { RedisSubscriber } from "./redis-sockets.ts";

/** The method of an ioredis client (ioredis 5 and later: new Redis(), redis.duplicate()) that Inferlo calls. */
export interface IoredisLike {
  call(command: string, ...args: string[]): Promise<unknown>;
}

/** The methods of a second ioredis connection that receives WebSocket broadcasts. */
export interface IoredisSubscriberLike {
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
}

const clientFix = 'Pass an ioredis client: import Redis from "ioredis"; createApp({ redis: ioredisClient(new Redis(process.env.REDIS_URL)) }). ioredis 5 or later is needed (it has redis.call()).';
const subscriberFix = 'Pass a second ioredis connection: createApp({ redis: ioredisClient(connection), sockets: { transport: "redis", subscriber: ioredisSubscriber(connection.duplicate()) } }).';

/** Which ioredis connections are subscribers, so the same connection is never also the command client. */
const subscribers = new WeakSet<object>();
const clients = new WeakSet<object>();

function describeValue(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object without the ioredis methods" : typeof value;
}

/** Inferlo's Redis client on an ioredis connection: createApp({ redis: ioredisClient(new Redis(url)) }). */
export function ioredisClient(redis: IoredisLike): RedisClient {
  const target = redis as unknown as Record<string, unknown> | null | undefined;
  if (!target || typeof target !== "object" || typeof target.call !== "function") {
    throw new InferloError("IL6064", `ioredisClient() needs an ioredis client (ioredis 5 or later), got ${describeValue(target)}.`, { fix: clientFix });
  }
  if (subscribers.has(target)) {
    throw new InferloError("IL6064", "ioredisClient() was given the connection already passed to ioredisSubscriber(); a subscribed connection cannot send other commands.", { fix: subscriberFix });
  }
  const options = target.options as { keyPrefix?: unknown } | undefined;
  if (options && typeof options.keyPrefix === "string" && options.keyPrefix !== "") {
    throw new InferloError("IL6064", `ioredisClient() was given a connection with keyPrefix "${options.keyPrefix}"; Inferlo prefixes its own keys with inferlo:<app name>:, and ioredis does not prefix SCAN patterns, so cache.clear() would miss entries.`, {
      fix: 'Give Inferlo a connection without keyPrefix: ioredisClient(connection.duplicate({ keyPrefix: "" })), and keep apps apart with createApp({ name }).',
    });
  }
  clients.add(target);
  return { sendCommand: (args) => redis.call(args[0]!, ...args.slice(1)) };
}

/**
 * The subscriber for WebSocket broadcasts across instances, on a second ioredis connection:
 * sockets: { transport: "redis", subscriber: ioredisSubscriber(connection.duplicate()) }.
 */
export function ioredisSubscriber(connection: IoredisSubscriberLike): RedisSubscriber {
  const target = connection as unknown as Record<string, unknown> | null | undefined;
  if (!target || typeof target !== "object" || typeof target.subscribe !== "function" || typeof target.unsubscribe !== "function" || typeof target.on !== "function") {
    throw new InferloError("IL6064", `ioredisSubscriber() needs an ioredis connection, got ${describeValue(target)}.`, { fix: subscriberFix });
  }
  if (clients.has(target)) {
    throw new InferloError("IL6064", "ioredisSubscriber() was given the connection passed to ioredisClient(); a subscribed connection cannot send other commands, so use a second one.", { fix: subscriberFix });
  }
  subscribers.add(target);
  const listeners = new Map<string, (message: string, channel: string) => void>();
  connection.on("message", (channel, message) => listeners.get(channel)?.(message, channel));
  return {
    async subscribe(channel, listener) {
      listeners.set(channel, listener);
      return connection.subscribe(channel);
    },
    async unsubscribe(channel) {
      listeners.delete(channel);
      return connection.unsubscribe(channel);
    },
  };
}
