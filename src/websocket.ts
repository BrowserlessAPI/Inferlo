/**
 * WebSocket plumbing shared by the app (src/app.ts) and the servers (src/serve.ts): the per-request upgrader a server
 * registers, the record of upgraded requests, Deno's built-in upgrade, and the RFC 6455 frame reader and writer used
 * on Node.js, where the runtime has no WebSocket server of its own. Web APIs only.
 */

import { InferloError } from "./errors.ts";

/** One open connection, as the app sees it: send a text message, or close with a code and reason. */
export interface SocketTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** What the app does with a connection's events. */
export interface SocketListener {
  message(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

/**
 * Accepts the WebSocket upgrade of one request: connects the app's listener to the new connection and returns the
 * response to answer with (Deno), or undefined when the server answers the handshake itself (Node.js, Bun).
 */
export type Upgrader = (connect: (transport: SocketTransport) => SocketListener) => Promise<Response | undefined>;

/** Set by serve() for each request it can upgrade (Node.js upgrade requests, every Bun request). */
export const upgraders = new WeakMap<Request, Upgrader>();

/** Requests the app upgraded, with Deno's upgrade response (null on Node.js and Bun, which answer it themselves). */
export const upgrades = new WeakMap<Request, Response | null>();

type DenoSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
};

/**
 * On Deno, a request from Deno.serve (or deno serve), which passes its handler info with a remoteAddr to app.fetch,
 * can be upgraded with Deno.upgradeWebSocket. Requests made any other way (app.request) cannot.
 */
export function denoUpgrader(req: Request, info: unknown): Upgrader | undefined {
  const deno = (globalThis as { Deno?: { upgradeWebSocket?(req: Request): { socket: DenoSocket; response: Response } } }).Deno;
  if (!deno?.upgradeWebSocket || typeof info !== "object" || info === null || !("remoteAddr" in info)) return undefined;
  return async (connect) => {
    const { socket, response } = deno.upgradeWebSocket!(req);
    const listener = connect({
      send: (text) => {
        if (socket.readyState === 1) socket.send(text);
      },
      close: (code, reason) => socket.close(code, reason),
    });
    socket.onmessage = (event) => listener.message(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
    socket.onclose = (event) => listener.close(event.code, event.reason);
    socket.onerror = () => {};
    return response;
  };
}

type BunSocket = { data: { connect: (transport: SocketTransport) => SocketListener; listener?: SocketListener }; send(text: string): void; close(code?: number, reason?: string): void };

/**
 * The websocket handlers for Bun.serve, so a Bun server that runs app.fetch serves the app's WebSocket routes:
 * Bun.serve({ fetch: app.fetch, websocket: bunWebSocket }). serve() and app.listen() on Bun use them already.
 */
export const bunWebSocket = {
  open(ws: BunSocket): void {
    ws.data.listener = ws.data.connect({ send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) });
  },
  message(ws: BunSocket, data: string | Uint8Array): void {
    ws.data.listener?.message(typeof data === "string" ? data : new Uint8Array(data));
  },
  close(ws: BunSocket, code: number, reason: string): void {
    ws.data.listener?.close(code, reason);
  },
};

/** On Bun, app.fetch(req, server) gets the Bun server, whose upgrade() hands the connection to bunWebSocket. */
export function bunUpgrader(req: Request, server: unknown): Upgrader | undefined {
  if (!(globalThis as { Bun?: unknown }).Bun || typeof (server as { upgrade?: unknown } | null)?.upgrade !== "function") return undefined;
  return async (connect) => {
    let upgraded: boolean;
    try {
      upgraded = (server as { upgrade(req: Request, options: object): boolean }).upgrade(req, { data: { connect } });
    } catch {
      upgraded = false;
    }
    if (!upgraded) {
      throw new InferloError("IL2011", "This Bun server cannot accept WebSocket connections.", { status: 501, fix: 'Pass the websocket handlers to Bun.serve: Bun.serve({ fetch: app.fetch, websocket: bunWebSocket }), with bunWebSocket from "@browserlessapi/inferlo".' });
    }
    return undefined;
  };
}

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key (RFC 6455 section 4.2.2). */
export async function acceptKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** True for a well-formed Sec-WebSocket-Key: 16 random bytes in base64. */
export function validKey(key: string | null): key is string {
  return typeof key === "string" && /^[A-Za-z0-9+/]{22}==$/.test(key);
}

export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** A complete, unmasked server frame. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const out = new Uint8Array(headerLength + length);
  out[0] = 0x80 | opcode;
  if (length < 126) out[1] = length;
  else if (length < 65536) {
    out[1] = 126;
    out[2] = length >> 8;
    out[3] = length & 0xff;
  } else {
    out[1] = 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(length));
  }
  out.set(payload, headerLength);
  return out;
}

/** A close frame with a status code and a reason (cut to the 123 bytes a close frame has room for). */
export function encodeClose(code: number, reason: string): Uint8Array {
  const text = new TextEncoder().encode(reason).subarray(0, 123);
  const payload = new Uint8Array(2 + text.byteLength);
  payload[0] = code >> 8;
  payload[1] = code & 0xff;
  payload.set(text, 2);
  return encodeFrame(OP_CLOSE, payload);
}

export interface FrameEvents {
  /** A complete text (string) or binary (bytes) message. */
  message(data: string | Uint8Array): void;
  ping(payload: Uint8Array): void;
  /** The client's close frame: its code (1005 when it sent none) and reason. */
  close(code: number, reason: string): void;
  /** The client broke the protocol: close the connection with this code. */
  error(code: number, reason: string): void;
}

/**
 * Reads client frames (RFC 6455): masked, possibly fragmented, with ping, pong and close control frames in between.
 * A message larger than maxMessageBytes is an error (1009), so a client cannot make the server buffer without end.
 */
export class FrameReader {
  #buffer: Uint8Array = new Uint8Array(0);
  #parts: Uint8Array[] = [];
  #size = 0;
  #opcode = -1;
  #done = false;
  readonly #max: number;
  readonly #events: FrameEvents;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(maxMessageBytes: number, events: FrameEvents) {
    this.#max = maxMessageBytes;
    this.#events = events;
  }

  push(chunk: Uint8Array): void {
    if (this.#done) return;
    if (this.#buffer.byteLength === 0) this.#buffer = chunk;
    else {
      const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      joined.set(this.#buffer);
      joined.set(chunk, this.#buffer.byteLength);
      this.#buffer = joined;
    }
    while (!this.#done && this.#next());
  }

  #fail(code: number, reason: string): false {
    this.#done = true;
    this.#events.error(code, reason);
    return false;
  }

  /** Reads one frame from the buffer; false when more bytes are needed or reading stopped. */
  #next(): boolean {
    const b = this.#buffer;
    if (b.byteLength < 2) return false;
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    if ((b[0]! & 0x70) !== 0) return this.#fail(1002, "Extensions are not supported");
    if ((b[1]! & 0x80) === 0) return this.#fail(1002, "Client frames must be masked");
    let length = b[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.byteLength < 4) return false;
      length = (b[2]! << 8) | b[3]!;
      offset = 4;
    } else if (length === 127) {
      if (b.byteLength < 10) return false;
      const big = new DataView(b.buffer, b.byteOffset + 2, 8).getBigUint64(0);
      if (big > BigInt(this.#max)) return this.#fail(1009, "Message too big");
      length = Number(big);
      offset = 10;
    }
    const control = opcode >= 0x8;
    if (control && (!fin || length > 125)) return this.#fail(1002, "Invalid control frame");
    if (![OP_CONTINUATION, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) return this.#fail(1002, "Unknown opcode");
    if (!control && this.#size + length > this.#max) return this.#fail(1009, "Message too big");
    if (b.byteLength < offset + 4 + length) return false;
    const mask = b.subarray(offset, offset + 4);
    const payload = b.slice(offset + 4, offset + 4 + length);
    for (let i = 0; i < payload.byteLength; i++) payload[i]! ^= mask[i & 3]!;
    this.#buffer = b.subarray(offset + 4 + length);

    if (opcode === OP_PING) this.#events.ping(payload);
    else if (opcode === OP_PONG) {
      // Answers to pings; nothing to do.
    } else if (opcode === OP_CLOSE) {
      if (payload.byteLength === 1) return this.#fail(1002, "Invalid close frame");
      const code = payload.byteLength >= 2 ? (payload[0]! << 8) | payload[1]! : 1005;
      let reason = "";
      try {
        reason = this.#decoder.decode(payload.subarray(2));
      } catch {
        return this.#fail(1007, "Close reason is not UTF-8");
      }
      this.#done = true;
      this.#events.close(code, reason);
      return false;
    } else {
      if (opcode === OP_CONTINUATION ? this.#opcode === -1 : this.#opcode !== -1) return this.#fail(1002, "Unexpected frame order");
      if (opcode !== OP_CONTINUATION) this.#opcode = opcode;
      this.#parts.push(payload);
      this.#size += length;
      if (fin) {
        const data = this.#parts.length === 1 ? this.#parts[0]! : concat(this.#parts, this.#size);
        const kind = this.#opcode;
        this.#parts = [];
        this.#size = 0;
        this.#opcode = -1;
        if (kind === OP_TEXT) {
          let text: string;
          try {
            text = this.#decoder.decode(data);
          } catch {
            return this.#fail(1007, "Text message is not UTF-8");
          }
          this.#events.message(text);
        } else this.#events.message(data);
      }
    }
    return true;
  }
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
