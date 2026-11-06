/**
 * Events between services over Redis Streams: createApp({ name: "billing", redis, events: { transport: "redis" } }).
 *
 * Keys (shared by every app on the Redis, so services find each other's events):
 *   inferlo:events:<event name>   a stream with one entry per published event (fields id, payload, publishedAt,
 *                                 and traceparent and tracestate with tracing), trimmed to about maxLength entries
 *
 * Each app reads with a consumer group named after the app (createApp({ name })), so every service subscribed to
 * an event gets each event once, and its instances share the work. An entry is acknowledged (XACK) after its jobs
 * are queued; an entry a crashed instance read but did not acknowledge is claimed again (XAUTOCLAIM) after
 * staleAfterMs. Delivery is at least once; the jobs it queues have ids derived from the event id, so a repeated
 * delivery queues nothing new.
 */
import type { EventMessage, EventTransport } from "./events.ts";
import type { RedisClient } from "./redis.ts";

export const EVENT_STREAM_PREFIX = "inferlo:events:";

export interface RedisEventTransportOptions {
  /** The consumer group: the app name. */
  group: string;
  /** Entries kept per event stream (approximately, trimmed by Redis as events are added). Default 100,000. */
  maxLength?: number;
  /** An entry read but not acknowledged for this long (its instance stopped) is delivered again. Default 30 seconds. */
  staleAfterMs?: number;
  /** Entries read per stream and call. Default 100. */
  batch?: number;
}

type Fields = (string | Uint8Array)[] | null | undefined;
type Entry = [string | Uint8Array, Fields] | null | undefined;

/** Consumers with nothing pending that have not read for this long (stopped instances) are removed from the group. */
const IDLE_CONSUMER_MS = 60 * 60_000;

/** Field-value pairs as Redis sends them: a flat array (RESP2), or an object or Map (RESP3 clients). */
function fieldMap(fields: unknown): Map<string, string> | undefined {
  const map = new Map<string, string>();
  if (Array.isArray(fields)) {
    for (let i = 0; i + 1 < fields.length; i += 2) map.set(String(fields[i]), String(fields[i + 1]));
  } else if (fields instanceof Map) {
    for (const [k, v] of fields) map.set(String(k), String(v));
  } else if (typeof fields === "object" && fields !== null) {
    for (const [k, v] of Object.entries(fields)) map.set(k, String(v));
  } else return undefined;
  return map;
}

/** The entries of an XREADGROUP reply: [[key, entries], ...] (RESP2), or { key: entries } / Map (RESP3). */
function streamEntries(reply: unknown): Entry[] {
  if (reply === null || reply === undefined) return [];
  const lists: unknown[] = Array.isArray(reply)
    ? reply.map((r) => (Array.isArray(r) ? r[1] : undefined))
    : reply instanceof Map
      ? [...reply.values()]
      : typeof reply === "object"
        ? Object.values(reply)
        : [];
  return lists.flatMap((list) => (Array.isArray(list) ? (list as Entry[]) : []));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redisEventTransport(client: RedisClient, options: RedisEventTransportOptions): EventTransport {
  const group = options.group;
  const maxLength = options.maxLength ?? 100_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  const batch = options.batch ?? 100;
  // One consumer per transport (per app instance). Stopped instances' consumers are removed after IDLE_CONSUMER_MS.
  const consumer = `${group}:${crypto.randomUUID()}`;
  const ready = new Set<string>();
  let lastCleanup = 0;
  const stream = (name: string) => `${EVENT_STREAM_PREFIX}${name}`;

  /** Creates the group at the end of the stream (and the stream) the first time this instance reads it. */
  const ensureGroup = async (key: string) => {
    if (ready.has(key)) return;
    try {
      await client.sendCommand(["XGROUP", "CREATE", key, group, "$", "MKSTREAM"]);
    } catch (error) {
      if (!/BUSYGROUP/.test(errorText(error))) throw error;
    }
    ready.add(key);
  };

  const parse = (name: string, id: string, fields: Map<string, string>): EventMessage | undefined => {
    const eventId = fields.get("id");
    const payload = fields.get("payload");
    if (!eventId || payload === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      return undefined;
    }
    const at = new Date(fields.get("publishedAt") ?? Number(id.split("-")[0]));
    const traceparent = fields.get("traceparent");
    const tracestate = fields.get("tracestate");
    return {
      id: eventId,
      name,
      payload: value,
      publishedAt: Number.isNaN(at.getTime()) ? new Date() : at,
      ...(traceparent ? { trace: { traceparent, ...(tracestate ? { tracestate } : {}) } } : {}),
      ...(fields.get("tenantId") ? { tenantId: fields.get("tenantId") } : {}),
    };
  };

  /** Removes consumers of stopped instances: nothing pending and idle for an hour. */
  const cleanup = async (key: string) => {
    const reply = await client.sendCommand(["XINFO", "CONSUMERS", key, group]);
    for (const row of Array.isArray(reply) ? reply : []) {
      const info = fieldMap(row);
      if (!info) continue;
      const name = info.get("name");
      if (name && name !== consumer && Number(info.get("pending")) === 0 && Number(info.get("idle")) > IDLE_CONSUMER_MS) {
        await client.sendCommand(["XGROUP", "DELCONSUMER", key, group, name]);
      }
    }
  };

  return {
    name: "redis",

    async send(message) {
      const fields = ["id", message.id, "payload", JSON.stringify(message.payload ?? null), "publishedAt", message.publishedAt.toISOString()];
      if (message.trace?.traceparent) fields.push("traceparent", message.trace.traceparent);
      if (message.trace?.tracestate) fields.push("tracestate", message.trace.tracestate);
      if (message.tenantId) fields.push("tenantId", message.tenantId);
      await client.sendCommand(["XADD", stream(message.name), "MAXLEN", "~", String(maxLength), "*", ...fields]);
    },

    async receive(names, deliver) {
      let delivered = 0;
      let failure: unknown;
      const handle = async (key: string, name: string, entry: Entry) => {
        if (!Array.isArray(entry)) return;
        const id = String(entry[0]);
        const fields = Array.isArray(entry[1]) ? fieldMap(entry[1]) : undefined;
        const message = fields ? parse(name, id, fields) : undefined;
        if (message) {
          try {
            await deliver(message);
          } catch (error) {
            failure ??= error; // left pending: delivered again after staleAfterMs
            return;
          }
          delivered++;
        }
        // Delivered, trimmed away before it was read again, or not an Inferlo event: acknowledge it.
        await client.sendCommand(["XACK", key, group, id]);
      };

      const cleanupDue = Date.now() - lastCleanup > IDLE_CONSUMER_MS / 4;
      if (cleanupDue) lastCleanup = Date.now();
      for (const name of names) {
        const key = stream(name);
        try {
          await ensureGroup(key);
          // Entries another instance read but never acknowledged (it stopped): claim them for this one.
          const claimed = (await client.sendCommand(["XAUTOCLAIM", key, group, consumer, String(staleAfterMs), "0-0", "COUNT", String(batch)])) as [unknown, Entry[]] | null;
          for (const entry of Array.isArray(claimed?.[1]) ? claimed[1] : []) await handle(key, name, entry);
          const read = await client.sendCommand(["XREADGROUP", "GROUP", group, consumer, "COUNT", String(batch), "STREAMS", key, ">"]);
          for (const entry of streamEntries(read)) await handle(key, name, entry);
          if (cleanupDue) await cleanup(key);
        } catch (error) {
          // The stream or the group was deleted (for example by FLUSHDB): create them again on the next call.
          if (/NOGROUP/.test(errorText(error))) ready.delete(key);
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      return delivered;
    },
  };
}
