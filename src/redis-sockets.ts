/**
 * WebSocket broadcasts across instances over Redis Pub/Sub:
 * createApp({ name: "boards", redis, sockets: { transport: "redis", subscriber: await redis.duplicate().connect() } }).
 *
 * Every broadcast is sent to the sockets of this process and published on one channel per app,
 * inferlo:<app name>:sockets, as JSON { o: instance id, k: room key (with the tenant), d: message text }. Each
 * instance with open sockets subscribes to the channel (on its first WebSocket connection) and sends what other
 * instances published to its own sockets in that room. Pub/Sub keeps nothing: an instance that is not subscribed
 * when a broadcast is published does not get it, as with sockets that join a room after a broadcast.
 */
import { InferloError } from "./errors.ts";
import { ioredisDirect, isIoredis, type RedisClient } from "./redis.ts";
import type { SocketRelay } from "./sockets.ts";

/**
 * A second, connected Redis client for receiving broadcasts: a client in subscriber mode cannot send other
 * commands, so it cannot be the createApp({ redis }) client. With the redis package: await redis.duplicate().connect().
 * For ioredis, wrap a second connection: ioredisSubscriber(connection.duplicate()) from "@browserlessapi/inferlo/ioredis".
 */
export interface RedisSubscriber {
  subscribe(channel: string, listener: (message: string, channel: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
}

export interface SocketsConfig {
  /**
   * How broadcasts reach the sockets of other instances. Default: none, sockets.broadcast reaches the sockets of this
   * process only. "redis": Redis Pub/Sub in the Redis of createApp({ redis }) (needs name and subscriber), so a
   * broadcast from any instance or from inferlo worker reaches every instance's sockets in the room.
   */
  transport?: "redis";
  /** With transport "redis": a second connected Redis client that receives broadcasts (await redis.duplicate().connect()). */
  subscriber?: RedisSubscriber;
}

const FIX = 'Use createApp({ name: "boards", redis, sockets: { transport: "redis", subscriber: await redis.duplicate().connect() } }), with redis = await createClient({ url: process.env.REDIS_URL }).connect().';

function invalid(message: string): InferloError {
  return new InferloError("IL6036", message, { fix: FIX });
}

/** Checks createApp({ sockets }) at startup and returns the subscriber for transport "redis". Raises IL6036. */
export function checkSocketsConfig(config: unknown, redis: RedisClient | undefined, name: string | undefined): RedisSubscriber | undefined {
  if (config === undefined) return undefined;
  if (typeof config !== "object" || config === null || Array.isArray(config)) throw invalid("createApp({ sockets }) must be an object.");
  const { transport, subscriber } = config as SocketsConfig;
  const unknown = Object.keys(config).filter((key) => key !== "transport" && key !== "subscriber");
  if (unknown.length) throw invalid(`Unknown sockets option ${unknown.map((key) => `"${key}"`).join(", ")}.`);
  if (transport === undefined) {
    if (subscriber !== undefined) throw invalid('sockets.subscriber is only used with transport "redis".');
    return undefined;
  }
  if (transport !== "redis") throw invalid(`Invalid sockets transport ${JSON.stringify(transport)}: the only transport is "redis".`);
  if (!redis) throw invalid('sockets transport "redis" needs a Redis client, but createApp has no redis option.');
  // Instances find each other by the channel named after the app, so apps sharing one Redis must have names.
  if (!name) throw invalid('sockets transport "redis" needs createApp({ name }): the instances of an app share one channel, named after the app.');
  if (typeof subscriber === "object" && subscriber !== null && isIoredis(subscriber)) throw ioredisDirect("sockets.subscriber", 'sockets: { transport: "redis", subscriber: ioredisSubscriber(connection.duplicate()) }');
  if (typeof subscriber !== "object" || subscriber === null || typeof subscriber.subscribe !== "function" || typeof subscriber.unsubscribe !== "function") {
    throw invalid('sockets transport "redis" needs a subscriber: a second connected Redis client with subscribe and unsubscribe.');
  }
  if ((subscriber as unknown) === redis) throw invalid("sockets.subscriber must be a second Redis client, not the createApp({ redis }) client: a subscribed client cannot send other commands.");
  return subscriber;
}

export function redisSocketRelay(client: RedisClient, subscriber: RedisSubscriber, channel: string, onError: (message: string, error?: unknown) => void): SocketRelay {
  const instance = crypto.randomUUID();
  let listener: ((message: string) => void) | undefined;
  return {
    async publish(key, text) {
      await client.sendCommand(["PUBLISH", channel, JSON.stringify({ o: instance, k: key, d: text })]);
    },
    async start(deliver) {
      listener = (message: string) => {
        let parsed: { o?: unknown; k?: unknown; d?: unknown };
        try {
          parsed = JSON.parse(String(message));
        } catch (error) {
          return onError(`ignored a message on ${channel} that is not JSON`, error);
        }
        if (parsed.o === instance) return;
        if (typeof parsed.k !== "string" || typeof parsed.d !== "string") return onError(`ignored a message on ${channel} without a room and data`);
        deliver(parsed.k, parsed.d);
      };
      await subscriber.subscribe(channel, (message) => listener?.(message));
    },
    async stop() {
      listener = undefined;
      await subscriber.unsubscribe(channel);
    },
  };
}
