/**
 * Rooms for WebSocket routes: socket.join(room) in a route.ws handler, and sockets.broadcast(room, data) from routes,
 * WebSocket handlers, jobs and app.sockets. Rooms follow the tenant like ctx.db: a socket opened by a user with a
 * tenant joins that tenant's room, and a broadcast reaches the rooms of the tenant it is made for. Web APIs only.
 */

import { InferloError } from "./errors.ts";
import { checkTenantId } from "./db/table.ts";

/** The longest room name, in characters. */
export const MAX_ROOM = 200;

export interface BroadcastOptions {
  /**
   * The tenant whose room gets the message. In routes, WebSocket handlers and jobs it defaults to the tenant of the
   * signed-in user or job; with app.sockets to none. null sends to the room of sockets without a tenant.
   */
  tenantId?: string | null;
}

/** Send to every socket in a room: ctx.sockets in routes, WebSocket handlers and jobs, and app.sockets. */
export interface Sockets {
  /**
   * Send data, as JSON, to every open socket that joined the room (with socket.join(room)) in this process.
   * Rooms are per tenant: in a request or job with a tenant, only that tenant's sockets get it.
   */
  broadcast(room: string, data: unknown, options?: BroadcastOptions): Promise<void>;
}

/** app.sockets: broadcast, and how many sockets are open in this process. */
export interface AppSockets extends Sockets {
  /** Open sockets in this process, or in one room (of the tenant in options, none by default). */
  count(room?: string, options?: BroadcastOptions): number;
}

/** One open socket as the hub sees it. */
export interface RoomMember {
  /** Sends text that is already JSON; does nothing once the socket is closed. */
  sendText(text: string): void;
}

/**
 * Carries broadcasts to the other instances of the app (Redis Pub/Sub with sockets: { transport: "redis" }).
 * Internal: the hub publishes each broadcast, and delivers what start() receives from other instances.
 */
export interface SocketRelay {
  publish(key: string, text: string): Promise<void>;
  /** Starts receiving: deliver(key, text) for each broadcast of another instance. */
  start(deliver: (key: string, text: string) => void): Promise<void>;
  stop(): Promise<void>;
}

/** The rooms of one app, in memory. Internal. */
export interface SocketHub extends AppSockets {
  /** Resolves once broadcasts from other instances arrive here (at once without a relay). Retried after a failure. */
  ready(): Promise<void>;
  /** Stops receiving broadcasts from other instances (app.close()). */
  stop(): Promise<void>;
  open(member: RoomMember): void;
  join(member: RoomMember, room: string, tenant: string | null): void;
  leave(member: RoomMember, room: string, tenant: string | null): void;
  /** Removes a closed socket from every room. */
  drop(member: RoomMember): void;
  /** ctx.sockets for a request, socket or job of this tenant (null for none). */
  forTenant(tenant: string | null): Sockets;
}

export function checkRoom(room: unknown): string {
  if (typeof room !== "string" || room.length === 0 || room.length > MAX_ROOM) {
    throw new InferloError("IL2014", `A room name must be a non-empty string of at most ${MAX_ROOM} characters, got ${typeof room === "string" ? `a string of ${room.length} characters` : room === null ? "null" : typeof room}.`, {
      fix: 'Name rooms after what they are about, with its id: socket.join(`project:${params.id}`), then sockets.broadcast(`project:${params.id}`, data).',
    });
  }
  return room;
}

function keyOf(room: string, tenant: string | null): string {
  // Length-prefixed, so no tenant id and room name can make the key of another tenant's room.
  return tenant === null ? `-${room}` : `${tenant.length}:${tenant}:${room}`;
}

export function createSocketHub(relay?: SocketRelay): SocketHub {
  const members = new Set<RoomMember>();
  const rooms = new Map<string, Set<RoomMember>>();
  const joined = new Map<RoomMember, Set<string>>();

  const tenantFrom = (options: BroadcastOptions | undefined, fallback: string | null): string | null => {
    if (!options || options.tenantId === undefined) return fallback;
    return options.tenantId === null ? null : checkTenantId(options.tenantId);
  };

  const deliver = (key: string, text: string): void => {
    const set = rooms.get(key);
    if (!set) return;
    for (const member of [...set]) member.sendText(text);
  };

  const send = async (room: string, data: unknown, tenant: string | null): Promise<void> => {
    const text = data === undefined ? undefined : JSON.stringify(data);
    if (text === undefined) {
      throw new InferloError("IL2014", "sockets.broadcast() needs data that can be sent as JSON.", { fix: 'Pass the message as the second argument: sockets.broadcast(room, { type: "note.created", note }).' });
    }
    const key = keyOf(room, tenant);
    deliver(key, text);
    if (relay) await relay.publish(key, text);
  };

  const forTenant = (tenant: string | null): Sockets => ({
    broadcast: async (room, data, options) => send(checkRoom(room), data, tenantFrom(options, tenant)),
  });

  let started: Promise<void> | undefined;

  const base = forTenant(null);
  return {
    broadcast: base.broadcast,
    count(room, options) {
      if (room === undefined) return members.size;
      return rooms.get(keyOf(checkRoom(room), tenantFrom(options, null)))?.size ?? 0;
    },
    open(member) {
      members.add(member);
    },
    join(member, room, tenant) {
      if (!members.has(member)) return;
      const key = keyOf(checkRoom(room), tenant);
      let set = rooms.get(key);
      if (!set) rooms.set(key, (set = new Set()));
      set.add(member);
      let keys = joined.get(member);
      if (!keys) joined.set(member, (keys = new Set()));
      keys.add(key);
    },
    leave(member, room, tenant) {
      const key = keyOf(checkRoom(room), tenant);
      const set = rooms.get(key);
      if (set?.delete(member) && set.size === 0) rooms.delete(key);
      joined.get(member)?.delete(key);
    },
    drop(member) {
      members.delete(member);
      for (const key of joined.get(member) ?? []) {
        const set = rooms.get(key);
        if (set?.delete(member) && set.size === 0) rooms.delete(key);
      }
      joined.delete(member);
    },
    forTenant,
    ready() {
      if (!relay) return Promise.resolve();
      started ??= relay.start(deliver).catch((error: unknown) => {
        started = undefined;
        throw error;
      });
      return started;
    },
    async stop() {
      if (!started) return;
      const was = started;
      started = undefined;
      await was.then(() => relay!.stop(), () => {});
    },
  };
}
