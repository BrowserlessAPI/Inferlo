/**
 * A small SMTP client (RFC 5321) for mail({ smtp }): one connection per message, STARTTLS (RFC 3207) or TLS from
 * the start, AUTH PLAIN or LOGIN (RFC 4954), dot-stuffing. node:net and node:tls are loaded with a dynamic import()
 * on first use, so importing Inferlo stays free of Node-only modules. Runs on Node.js, Bun and Deno.
 */
import { InferloError } from "./errors.ts";
import type { SmtpConfig } from "./mail.ts";

type Net = typeof import("node:net");
type Tls = typeof import("node:tls");
type Socket = import("node:net").Socket;

let modules: Promise<{ net: Net; tls: Tls; hostname: string }> | undefined;

function load(): Promise<{ net: Net; tls: Tls; hostname: string }> {
  return (modules ??= Promise.all([import("node:net"), import("node:tls"), import("node:os")]).then(([net, tls, os]) => {
    const name = os.hostname();
    return { net, tls, hostname: /^[A-Za-z0-9.-]+$/.test(name) && name.includes(".") ? name : "localhost" };
  }));
}

interface Reply {
  code: number;
  lines: string[];
}

const failure = (message: string, fix: string, details: Record<string, unknown>, cause?: unknown) =>
  new InferloError("IL6071", message, { status: 502, fix, details, cause, expose: false });

/** Reads SMTP replies (possibly multi-line, "250-..." then "250 ...") from a socket. */
class Connection {
  socket!: Socket;
  private buffer = "";
  private lines: string[] = [];
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | undefined;
  private failed: Error | undefined;
  private readonly onData = (chunk: Buffer | string) => {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("latin1");
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines.map((l) => l.slice(4)) };
        this.lines = [];
        const w = this.waiting;
        this.waiting = undefined;
        w?.resolve(reply);
      }
    }
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error("The SMTP server closed the connection."));

  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  attach(socket: Socket): void {
    if (this.socket) {
      this.socket.off("data", this.onData);
      this.socket.off("error", this.onError);
      this.socket.off("close", this.onClose);
    }
    this.socket = socket;
    this.buffer = "";
    this.lines = [];
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  private fail(error: Error): void {
    this.failed ??= error;
    const w = this.waiting;
    this.waiting = undefined;
    w?.reject(error);
  }

  read(): Promise<Reply> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new Error(`No reply from the SMTP server within ${this.timeoutMs} ms.`));
        this.socket.destroy();
      }, this.timeoutMs);
      this.waiting = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  write(text: string): void {
    this.socket.write(text, "latin1");
  }

  close(): void {
    this.socket.off("close", this.onClose);
    this.socket.end();
    this.socket.destroy();
  }
}

/** Writes a command and reads its reply; a reply with an unexpected code raises IL6071. */
async function command(conn: Connection, line: string | undefined, expect: number[], stage: string, shown = line): Promise<Reply> {
  if (line !== undefined) conn.write(`${line}\r\n`);
  const reply = await conn.read();
  if (!expect.includes(reply.code)) {
    const response = `${reply.code} ${reply.lines.join(" ")}`.slice(0, 500);
    const fix =
      stage === "auth"
        ? "Check the SMTP user name and password (many providers need an app password or API key here)."
        : stage === "recipient"
          ? "Check the recipient address; the server refused it, so the message was not sent to anyone."
          : stage === "sender"
            ? "Use a from address the SMTP account may send as (a verified sender or domain)."
            : "Check the SMTP server settings; the server's reply is in details.response.";
    throw failure(`The SMTP server refused ${shown ?? "the connection"}: ${response}`, fix, { stage, code: reply.code, response, permanent: reply.code >= 500 });
  }
  return reply;
}

function connect(net: Net, tls: Tls, config: SmtpConfig, conn: Connection): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Could not connect to ${config.host}:${config.port} within ${config.timeoutMs} ms.`));
    }, config.timeoutMs);
    const done = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const socket: Socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: net.isIP(config.host) ? undefined : config.host, ca: config.ca ? [...tls.rootCertificates, ...config.ca] : undefined }, done)
      : net.connect({ host: config.host, port: config.port }, done);
    socket.on("error", onError);
    conn.attach(socket);
  });
}

function upgrade(net: Net, tls: Tls, config: SmtpConfig, plain: Socket, conn: Connection): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      secured.destroy();
      reject(new Error(`The TLS handshake with ${config.host} did not finish within ${config.timeoutMs} ms.`));
    }, config.timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const secured = tls.connect({ socket: plain, servername: net.isIP(config.host) ? undefined : config.host, ca: config.ca ? [...tls.rootCertificates, ...config.ca] : undefined }, () => {
      clearTimeout(timer);
      secured.off("error", onError);
      resolve(secured);
    });
    secured.on("error", onError);
    conn.attach(secured);
  });
}

const extensions = (reply: Reply) => reply.lines.slice(1).map((l) => l.toUpperCase());

/** "." at the start of a line is doubled (RFC 5321 4.5.2), and the message ends with CRLF.CRLF. */
export function dotStuff(raw: string): string {
  const text = raw.endsWith("\r\n") ? raw : `${raw}\r\n`;
  return text.replace(/(^|\r\n)\./g, "$1..") + ".\r\n";
}

/** Sends one message. Raises IL6071 for every failure, with details.stage telling where it stopped. */
export async function sendSmtp(config: SmtpConfig, envelope: { from: string; to: string[] }, raw: string): Promise<void> {
  let loaded: Awaited<ReturnType<typeof load>>;
  try {
    loaded = await load();
  } catch (cause) {
    throw failure("SMTP needs TCP sockets (node:net and node:tls), which this runtime does not have.", "Send email with SMTP on Node.js, Bun or Deno. On Cloudflare Workers, use mail({ transport }) with your email provider's HTTP API.", { stage: "runtime" }, cause);
  }
  const { net, tls, hostname } = loaded;
  const conn = new Connection(config.timeoutMs);
  let stage = "connect";
  try {
    let socket = await connect(net, tls, config, conn);
    await command(conn, undefined, [220], "greeting");
    const ehloName = config.name ?? hostname;
    stage = "ehlo";
    let ehlo = await command(conn, `EHLO ${ehloName}`, [250], "ehlo");
    let secure = config.secure;
    if (!secure) {
      if (extensions(ehlo).some((e) => e === "STARTTLS")) {
        stage = "starttls";
        await command(conn, "STARTTLS", [220], "starttls");
        socket = await upgrade(net, tls, config, socket, conn);
        secure = true;
        ehlo = await command(conn, `EHLO ${ehloName}`, [250], "ehlo");
      } else if (config.requireTLS) {
        throw failure(`The SMTP server ${config.host}:${config.port} does not offer STARTTLS, and TLS is required.`, "Use the provider's TLS port (smtps:// on 465, or 587 with STARTTLS). Only for a server you control on a private network, set requireTLS: false.", { stage: "starttls" });
      }
    }
    if (config.user !== undefined) {
      stage = "auth";
      const auth = extensions(ehlo).find((e) => e.startsWith("AUTH ") || e.startsWith("AUTH="));
      const mechanisms = auth ? auth.slice(5).split(/\s+/) : [];
      const credentials = new TextEncoder();
      const b64 = (text: string) => {
        const bytes = credentials.encode(text);
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
      };
      if (mechanisms.includes("PLAIN")) {
        await command(conn, `AUTH PLAIN ${b64(`\u0000${config.user}\u0000${config.pass}`)}`, [235], "auth", "AUTH PLAIN");
      } else if (mechanisms.includes("LOGIN")) {
        await command(conn, "AUTH LOGIN", [334], "auth", "AUTH LOGIN");
        await command(conn, b64(config.user), [334], "auth", "AUTH LOGIN (user name)");
        await command(conn, b64(config.pass ?? ""), [235], "auth", "AUTH LOGIN (password)");
      } else {
        throw failure(`The SMTP server ${config.host} offers no login Inferlo supports (PLAIN or LOGIN)${secure ? "" : " on an unencrypted connection"}.`, "Check the port and that the server allows SMTP login; leave out user and pass for a server that needs none.", { stage: "auth", offered: mechanisms });
      }
    }
    stage = "sender";
    await command(conn, `MAIL FROM:<${envelope.from}>`, [250], "sender");
    stage = "recipient";
    for (const to of envelope.to) await command(conn, `RCPT TO:<${to}>`, [250, 251], "recipient");
    stage = "data";
    await command(conn, "DATA", [354], "data");
    await command(conn, dotStuff(raw).replace(/\r\n$/, ""), [250], "data", "the message");
    stage = "quit";
    conn.write("QUIT\r\n");
    await conn.read().catch(() => undefined);
    conn.close();
  } catch (error) {
    try {
      if (conn.socket && !conn.socket.destroyed) {
        if (stage === "sender" || stage === "recipient") conn.write("RSET\r\nQUIT\r\n");
        conn.close();
      }
    } catch {
      // the connection is already gone
    }
    if (error instanceof InferloError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const tlsError = /certificate|self[- ]signed|SSL|TLS|handshake/i.test(message);
    throw failure(
      `Sending email through ${config.host}:${config.port} failed at ${stage}: ${message}`,
      tlsError
        ? "The server's TLS certificate was not accepted. Use the host name the certificate names, or pass the private CA in mail({ smtp: { ca } }); certificates are always verified."
        : "Check SMTP host and port and that this server can reach it (outgoing port 25 is blocked by most clouds; use 587 or 465).",
      { stage },
      error,
    );
  }
}
