// Email (mail() and createApp({ mail })): options and messages are checked, templates fill and escape their
// variables, the MIME message is well formed, ctx.mail works in routes and jobs, and the SMTP client speaks STARTTLS,
// TLS from the start, AUTH PLAIN and LOGIN against a local SMTP server (Node.js, Bun and Deno).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import { after, describe, test } from "node:test";
import { createApp, InferloError, job, mail, memoryMail, route, t, type OutgoingMail } from "../src/index.ts";
import { smtpConfig } from "../src/mail.ts";
import { dotStuff } from "../src/smtp.ts";

const quiet = { info() {}, error() {} };
const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/smtp-tls/${name}`, import.meta.url), "utf8");
const CA = fixture("ca.pem");
const CERT = fixture("server.pem");
const KEY = fixture("server-key.pem");

const welcome = { subject: "Welcome, {{name}}", text: "Hi {{name}}, your plan is {{plan}}.", html: "<p>Hi {{name}}, your plan is <b>{{plan}}</b>.</p>" } as const;

/** The decoded parts of a raw message: headers of the top level, and every leaf part's headers and decoded body. */
function parse(raw: string) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of head!.replace(/\r\n /g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 2));
  }
  const leaves: { type: string; headers: string; body: string }[] = [];
  const walk = (text: string) => {
    const [h, ...b] = text.split("\r\n\r\n");
    const body = b.join("\r\n\r\n");
    const boundary = /boundary="([^"]+)"/.exec(h!);
    if (boundary) {
      for (const p of body.split(`--${boundary[1]}`).slice(1, -1)) walk(p.replace(/^\r\n/, "").replace(/\r\n$/, ""));
      return;
    }
    const type = /Content-Type: ([^;\r\n]+)/.exec(h!)![1]!;
    const bytes = Uint8Array.from(atob(body.replace(/\r\n/g, "")), (c) => c.charCodeAt(0));
    leaves.push({ type, headers: h!, body: new TextDecoder().decode(bytes) });
  };
  walk(raw);
  void rest;
  return { headers, leaves };
}

describe("mail() options", () => {
  test("SMTP URLs: smtps:// is TLS on 465, smtp:// is STARTTLS on 587, credentials are URL-decoded", () => {
    assert.deepEqual(smtpConfig("smtps://ana%40acme.com:p%40ss%2Fword@smtp.example.com"), {
      host: "smtp.example.com", port: 465, secure: true, user: "ana@acme.com", pass: "p@ss/word", requireTLS: true, ca: undefined, name: undefined, timeoutMs: 30000,
    });
    const plain = smtpConfig("smtp://smtp.example.com:2525");
    assert.equal(plain.port, 2525);
    assert.equal(plain.secure, false);
    assert.equal(plain.requireTLS, true);
    assert.equal(plain.user, undefined);
    assert.equal(smtpConfig("smtp://smtp.example.com").port, 587);
  });

  test("TLS is required except on this machine, unless requireTLS says otherwise", () => {
    assert.equal(smtpConfig("smtp://localhost:1025").requireTLS, false);
    assert.equal(smtpConfig("smtp://127.0.0.1:1025").requireTLS, false);
    assert.equal(smtpConfig("smtp://[::1]:1025").requireTLS, false);
    assert.equal(smtpConfig({ host: "localhost", port: 1025, requireTLS: true }).requireTLS, true);
    assert.equal(smtpConfig({ host: "mail.internal", requireTLS: false }).requireTLS, false);
    assert.equal(smtpConfig({ host: "mail.internal" }).requireTLS, true);
  });

  test("invalid options fail at startup with IL6068", () => {
    const bad: unknown[] = [
      { smtp: "not a url", from: "a@example.com" },
      { smtp: "http://smtp.example.com", from: "a@example.com" },
      { smtp: "smtp://smtp.example.com?tls=off", from: "a@example.com" },
      { smtp: { host: "smtp.example.com", user: "ana" }, from: "a@example.com" },
      { smtp: { host: "smtp.example.com", port: 70000 }, from: "a@example.com" },
      { smtp: { host: "smtp.example.com", rejectUnauthorized: false }, from: "a@example.com" },
      { smtp: { host: "smtp.example.com", ca: "not a pem" }, from: "a@example.com" },
      { smtp: "smtp://smtp.example.com", transport: memoryMail(), from: "a@example.com" },
      { from: "a@example.com" },
      { transport: memoryMail(), from: "not an address" },
      { transport: memoryMail(), from: "Ana\r\nBcc: x@example.com <a@example.com>" },
      { transport: { send() {} }, from: "a@example.com" },
      { transport: memoryMail(), from: "a@example.com", templates: { welcome: { subject: "Hi {{ name }}", text: "x" } } },
      { transport: memoryMail(), from: "a@example.com", templates: { welcome: { subject: "Hi" } } },
      { transport: memoryMail(), from: "a@example.com", templates: { welcome: { subject: "Hi", text: "x", body: "y" } } },
      { transport: memoryMail(), from: "a@example.com", sender: "x" },
    ];
    for (const options of bad) assert.throws(() => mail(options as never), isCode("IL6068"), JSON.stringify(options));
  });

  test("a mailer is not accepted as anything else, and createApp({ mail }) checks its value", () => {
    assert.throws(() => createApp({ mail: { send() {} } as never, logger: quiet }), isCode("IL6068"));
  });
});

describe("messages", () => {
  const outbox = memoryMail();
  const mailer = mail({ transport: outbox, from: "Acme <no-reply@acme.com>", replyTo: "help@acme.com", templates: { welcome } });
  const last = (): OutgoingMail => outbox.sent.at(-1)!;

  test("a template fills its variables, escapes them in html, and keeps the subject on one line", async () => {
    const info = await mailer.send({ to: "Ana Lima <ana@example.com>", template: "welcome", data: { name: "Ana <script>\r\nBcc: x@evil.test", plan: "Pro & Co" } });
    const sent = last();
    assert.equal(info.messageId, sent.messageId);
    assert.deepEqual(info.accepted, ["ana@example.com"]);
    assert.match(sent.messageId, /^[0-9a-f-]{36}@acme\.com$/);
    assert.equal(sent.message.subject, "Welcome, Ana <script> Bcc: x@evil.test");
    assert.equal(sent.message.text, "Hi Ana <script>\r\nBcc: x@evil.test, your plan is Pro & Co.");
    assert.equal(sent.message.html, "<p>Hi Ana &lt;script&gt;\r\nBcc: x@evil.test, your plan is <b>Pro &amp; Co</b>.</p>");
    const { headers, leaves } = parse(sent.raw);
    assert.equal(headers.get("from"), "Acme <no-reply@acme.com>");
    assert.equal(headers.get("to"), "Ana Lima <ana@example.com>");
    assert.equal(headers.get("reply-to"), "help@acme.com");
    assert.equal(headers.get("subject"), "Welcome, Ana <script> Bcc: x@evil.test");
    assert.equal(headers.has("bcc"), false);
    assert.equal(headers.get("mime-version"), "1.0");
    assert.equal(headers.get("message-id"), `<${sent.messageId}>`);
    assert.match(headers.get("date")!, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    assert.match(headers.get("content-type")!, /^multipart\/alternative; boundary="inferlo-[0-9a-f]{32}"$/);
    assert.deepEqual(leaves.map((l) => l.type), ["text/plain", "text/html"]);
    assert.equal(leaves[1]!.body, sent.message.html);
    // Every line is ASCII and at most 998 characters (RFC 5322).
    assert.ok(sent.raw.split("\r\n").every((line) => /^[\x20-\x7e\t]*$/.test(line) && line.length <= 998));
  });

  test("a missing variable, an unknown template or a template with its own subject is IL6070", async () => {
    await assert.rejects(mailer.send({ to: "a@example.com", template: "welcome", data: { name: "Ana" } } as never), (e: unknown) => isCode("IL6070")(e) && /\{\{plan\}\}/.test((e as Error).message));
    await assert.rejects(mailer.send({ to: "a@example.com", template: "goodbye", data: {} } as never), (e: unknown) => isCode("IL6070")(e) && /welcome/.test((e as InferloError).fix!));
    await assert.rejects(mailer.send({ to: "a@example.com", template: "welcome", data: { name: "A", plan: "B" }, subject: "x" } as never), isCode("IL6070"));
  });

  test("cc and bcc reach the envelope, bcc never the headers; from and replyTo can be set per message", async () => {
    await mailer.send({ to: ["a@example.com", "b@example.com"], cc: "Carla <c@example.com>", bcc: ["audit@acme.com", "a@example.com"], from: "billing@acme.com", replyTo: "Billing <billing@acme.com>", subject: "Invoice", text: "Attached." });
    const sent = last();
    assert.deepEqual(sent.envelope, { from: "billing@acme.com", to: ["a@example.com", "b@example.com", "c@example.com", "audit@acme.com"] });
    const { headers, leaves } = parse(sent.raw);
    assert.equal(headers.get("to"), "a@example.com, b@example.com");
    assert.equal(headers.get("cc"), "Carla <c@example.com>");
    assert.equal(headers.get("reply-to"), "Billing <billing@acme.com>");
    assert.equal(headers.has("bcc"), false);
    assert.ok(!sent.raw.includes("audit@acme.com"));
    assert.deepEqual(sent.message.bcc, ["audit@acme.com", "a@example.com"]);
    assert.deepEqual(leaves.map((l) => [l.type, l.body]), [["text/plain", "Attached."]]);
  });

  test("non-ASCII subjects, names and file names are encoded; attachments are base64 parts", async () => {
    const subject = "Ihre Rechnung für März: 120 € (Übersicht) ".repeat(3).trim();
    await mailer.send({
      to: "José Müller <jose@example.com>",
      subject,
      html: "<p>Grüße</p>",
      attachments: [
        { filename: "Übersicht März.pdf", content: new Uint8Array([37, 80, 68, 70, 0, 255]), type: "application/pdf" },
        { filename: "notes.txt", content: "line 1\nline 2" },
        { filename: "photo.png", content: new Blob([new Uint8Array([137, 80])], { type: "image/png" }) },
      ],
    });
    const sent = last();
    const { headers, leaves } = parse(sent.raw);
    const decodeWords = (v: string) =>
      v.split(" ").map((w) => new TextDecoder().decode(Uint8Array.from(atob(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!), (c) => c.charCodeAt(0)))).join("");
    assert.equal(decodeWords(headers.get("subject")!), subject);
    assert.ok(sent.raw.split("\r\n").every((line) => line.length <= 78), "encoded headers are folded");
    assert.match(headers.get("to")!, /^=\?UTF-8\?B\?.+\?= <jose@example\.com>$/);
    assert.equal(decodeWords(headers.get("to")!.replace(/ <jose@example\.com>$/, "")), "José Müller");
    assert.match(headers.get("content-type")!, /^multipart\/mixed;/);
    assert.deepEqual(leaves.map((l) => l.type), ["text/html", "application/pdf", "application/octet-stream", "image/png"]);
    assert.match(leaves[1]!.headers, /Content-Disposition: attachment;\r\n filename\*=UTF-8''%C3%9Cbersicht%20M%C3%A4rz\.pdf/);
    assert.match(leaves[2]!.headers, /filename="notes.txt"/);
    assert.equal(leaves[2]!.body, "line 1\nline 2");
    assert.deepEqual(sent.message.attachments.map((a) => [a.filename, a.type, a.content.length]), [["Übersicht März.pdf", "application/pdf", 6], ["notes.txt", "application/octet-stream", 13], ["photo.png", "image/png", 2]]);
  });

  test("custom headers are one ASCII line, and headers Inferlo sets cannot be overridden", async () => {
    await mailer.send({ to: "a@example.com", subject: "Digest", text: "x", headers: { "List-Unsubscribe": "<https://acme.com/u/42>" } });
    assert.equal(parse(last().raw).headers.get("list-unsubscribe"), "<https://acme.com/u/42>");
    await assert.rejects(mailer.send({ to: "a@example.com", subject: "x", text: "x", headers: { "X-Note": "a\r\nBcc: x@evil.test" } }), isCode("IL6070"));
    await assert.rejects(mailer.send({ to: "a@example.com", subject: "x", text: "x", headers: { Subject: "other" } }), isCode("IL6070"));
    await assert.rejects(mailer.send({ to: "a@example.com", subject: "x", text: "x", headers: { "Bad Name": "x" } }), isCode("IL6070"));
  });

  test("invalid messages are IL6070 and nothing is sent", async () => {
    const count = outbox.sent.length;
    const bad: unknown[] = [
      { to: "a@example.com\r\nBcc: x@evil.test", subject: "x", text: "x" },
      { to: "not-an-address", subject: "x", text: "x" },
      { to: [], subject: "x", text: "x" },
      { to: "a@example.com", subject: "", text: "x" },
      { to: "a@example.com", subject: "x" },
      { to: "a@example.com", subject: "x", text: "x", attachments: [{ filename: "../etc/passwd", content: "x" }] },
      { to: "a@example.com", subject: "x", text: "x", attachments: [{ filename: "a.txt", content: "x", type: "text/plain\r\nX: y" }] },
      { to: "a@example.com", subject: "x", text: "x", attachments: [{ filename: "a.txt", content: 42 }] },
      { to: "José <jose@exämple.com>", subject: "x", text: "x" },
    ];
    for (const message of bad) await assert.rejects(mailer.send(message as never), isCode("IL6070"), JSON.stringify(message));
    assert.equal(outbox.sent.length, count);
  });

  test("template names and variables are typed", () => {
    // Only checked by the type checker (npm run typecheck); never sent.
    const typed = (): void => {
      void mailer.send({ to: "a@example.com", template: "welcome", data: { name: "Ana", plan: "Pro" } });
      // @ts-expect-error plan is missing
      void mailer.send({ to: "a@example.com", template: "welcome", data: { name: "Ana" } });
      // @ts-expect-error there is no template "goodbye"
      void mailer.send({ to: "a@example.com", template: "goodbye", data: {} });
      // @ts-expect-error a message without a template needs a subject
      void mailer.send({ to: "a@example.com", text: "x" });
    };
    assert.equal(typeof typed, "function");
  });
});

describe("ctx.mail in routes and jobs", () => {
  const signup = route.post("/signup", { auth: "public", body: t.object({ email: t.email(), name: t.string() }) }).handle(async ({ body, jobs }) => {
    await jobs.enqueue(sendWelcome, body);
    return { ok: true };
  });
  const ping = route.post("/ping", { auth: "public" }).handle(async ({ mail }) => {
    const { accepted } = await mail.send({ to: "ops@acme.com", subject: "Ping", text: "pong" });
    return { accepted };
  });
  const sendWelcome = job("send-welcome", { input: t.object({ email: t.email(), name: t.string() }) }).handle(async ({ input, mail }) => {
    await mail.send({ to: input.email, template: "welcome", data: { name: input.name, plan: "Free" } });
  });

  test("routes and jobs send with ctx.mail, app.mail is the same mailer, describe shows it", async () => {
    const outbox = memoryMail();
    const app = createApp({ routes: [{ signup, ping }], jobs: [sendWelcome], mail: mail({ transport: outbox, from: "no-reply@acme.com", templates: { welcome } }), logger: quiet });
    const res = await app.request("/signup", { method: "POST", json: { email: "ana@example.com", name: "Ana" } });
    assert.equal(res.status, 200);
    assert.equal(outbox.sent.length, 0);
    assert.deepEqual(await app.jobs.runDue(), { done: 1, retried: 0, failed: 0 });
    assert.equal(outbox.sent[0]!.message.subject, "Welcome, Ana");
    assert.deepEqual(await (await app.request("/ping", { method: "POST" })).json(), { accepted: ["ops@acme.com"] });
    await app.mail.send({ to: "x@example.com", subject: "Direct", text: "x" });
    assert.equal(outbox.sent.length, 3);
    assert.deepEqual(app.describe().mail, { transport: "memory", templates: ["welcome"] });
  });

  test("a failing send fails the job attempt, so the job retries", async () => {
    let calls = 0;
    const flaky = { name: "flaky", async send() { calls++; if (calls === 1) throw new Error("down"); } };
    const app = createApp({ routes: [{ signup }], jobs: [sendWelcome], mail: mail({ transport: flaky, from: "no-reply@acme.com", templates: { welcome } }), logger: quiet });
    await app.request("/signup", { method: "POST", json: { email: "ana@example.com", name: "Ana" } });
    assert.deepEqual(await app.jobs.runDue(), { done: 0, retried: 1, failed: 0 });
    assert.deepEqual(await app.jobs.runDue({ now: new Date(Date.now() + 60_000) }), { done: 1, retried: 0, failed: 0 });
    assert.equal(calls, 2);
  });

  test("without a mail option, ctx.mail answers 500 IL6069 and describe shows null", async () => {
    const app = createApp({ routes: [{ ping }], logger: quiet });
    assert.equal(app.describe().mail, null);
    await assert.rejects(app.mail.send({ to: "a@example.com", subject: "x", text: "x" }), isCode("IL6069"));
    const res = await app.request("/ping", { method: "POST" });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, "IL6069");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A local SMTP server for the client tests.

interface ServerOptions {
  /** TLS from the first byte (smtps). */
  implicitTls?: boolean;
  starttls?: boolean;
  auth?: string[];
  user?: string;
  pass?: string;
  greet?: boolean;
}

interface Session {
  commands: string[];
  data?: string;
  tls: boolean;
}

async function smtpServer(options: ServerOptions = {}) {
  const sessions: Session[] = [];
  const sockets = new Set<net.Socket>();
  const handle = (socket: net.Socket, secure: boolean) => {
    const session: Session = { commands: [], tls: secure };
    sessions.push(session);
    let current: net.Socket = socket;
    let buffer = "";
    let mode: "command" | "data" | "login-user" | "login-pass" = "command";
    let loginUser = "";
    let data = "";
    const reply = (line: string) => current.write(`${line}\r\n`);
    const onLine = (line: string) => {
      if (mode === "data") {
        if (line === ".") {
          session.data = data.replace(/(^|\r\n)\.\./g, "$1.");
          mode = "command";
          return reply("250 2.0.0 queued");
        }
        data += `${line}\r\n`;
        return;
      }
      if (mode === "login-user") {
        loginUser = atob(line);
        mode = "login-pass";
        return reply("334 UGFzc3dvcmQ6");
      }
      if (mode === "login-pass") {
        mode = "command";
        return reply(loginUser === options.user && atob(line) === options.pass ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
      }
      session.commands.push(line);
      const verb = line.split(" ")[0]!.toUpperCase();
      if (verb === "EHLO") {
        const ext = ["250-test.local"];
        if (options.starttls && !session.tls) ext.push("250-STARTTLS");
        if (options.auth) ext.push(`250-AUTH ${options.auth.join(" ")}`);
        ext.push("250 8BITMIME");
        return reply(ext.join("\r\n"));
      }
      if (verb === "STARTTLS") {
        reply("220 2.0.0 ready");
        // The TLS handshake is passed on to a TLS server on its own port, and the session continues on its
        // decrypted socket. (Upgrading the accepted socket in place is not supported on every runtime: Bun 1.3.0.)
        const raw = current;
        raw.removeAllListeners("data");
        upgrades.push((secured) => {
          session.tls = true;
          current = secured;
          buffer = "";
          secured.on("data", onData);
        });
        const relay = net.connect(tlsPort, "127.0.0.1");
        sockets.add(relay);
        relay.on("error", () => raw.destroy());
        raw.on("close", () => relay.destroy());
        relay.on("close", () => raw.destroy());
        raw.pipe(relay);
        relay.pipe(raw);
        return;
      }
      if (verb === "AUTH") {
        const [, mech, arg] = line.split(" ");
        if (mech === "PLAIN") {
          const [, u, p] = atob(arg!).split("\u0000");
          return reply(u === options.user && p === options.pass ? "235 2.7.0 ok" : "535 5.7.8 bad credentials");
        }
        if (mech === "LOGIN") {
          mode = "login-user";
          return reply("334 VXNlcm5hbWU6");
        }
        return reply("504 unsupported");
      }
      if (verb === "MAIL") return reply("250 ok");
      if (verb === "RCPT") return reply(line.includes("refused") ? "550 5.1.1 no such user" : "250 ok");
      if (verb === "DATA") {
        mode = "data";
        data = "";
        return reply("354 go ahead");
      }
      if (verb === "RSET") return reply("250 ok");
      if (verb === "QUIT") {
        reply("221 bye");
        current.end();
        return;
      }
      reply("502 unknown");
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        onLine(line);
      }
    };
    socket.on("data", onData);
    socket.on("error", () => {});
    if (options.greet !== false) reply("220 test.local ESMTP");
  };
  // STARTTLS connections continue here, one upgrade at a time in the order they were asked for.
  const upgrades: ((secured: tls.TLSSocket) => void)[] = [];
  const tlsServer = tls.createServer({ key: KEY, cert: CERT }, (secured) => {
    sockets.add(secured);
    secured.on("error", () => {});
    upgrades.shift()?.(secured);
  });
  await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
  const tlsPort = (tlsServer.address() as net.AddressInfo).port;
  const server = options.implicitTls
    ? tls.createServer({ key: KEY, cert: CERT }, (socket) => {
        sockets.add(socket);
        handle(socket, true);
      })
    : net.createServer((socket) => {
        sockets.add(socket);
        handle(socket, false);
      });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    sessions,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => tlsServer.close(resolve));
    },
  };
}

describe("SMTP", () => {
  const servers: { close(): Promise<void> }[] = [];
  const start = async (options: ServerOptions) => {
    const server = await smtpServer(options);
    servers.push(server);
    return server;
  };
  after(async () => {
    for (const s of servers) await s.close();
  });

  test("STARTTLS, AUTH PLAIN and the message as built, with the server's certificate verified", async () => {
    const server = await start({ starttls: true, auth: ["PLAIN", "LOGIN"], user: "ana@acme.com", pass: "s3cret pass" });
    const mailer = mail({ smtp: { host: "localhost", port: server.port, user: "ana@acme.com", pass: "s3cret pass", ca: CA, requireTLS: true, name: "api.acme.com" }, from: "Acme <no-reply@acme.com>", templates: { welcome } });
    const info = await mailer.send({ to: "ana@example.com", bcc: "audit@acme.com", template: "welcome", data: { name: "Ana", plan: "Pro" } });
    const session = server.sessions[0]!;
    assert.equal(session.tls, true);
    assert.deepEqual(session.commands.map((c) => c.replace(/^AUTH PLAIN .*/, "AUTH PLAIN ...")), ["EHLO api.acme.com", "STARTTLS", "EHLO api.acme.com", "AUTH PLAIN ...", "MAIL FROM:<no-reply@acme.com>", "RCPT TO:<ana@example.com>", "RCPT TO:<audit@acme.com>", "DATA", "QUIT"]);
    assert.equal(parse(session.data!).headers.get("message-id"), `<${info.messageId}>`);
    assert.equal(parse(session.data!).leaves[0]!.body, "Hi Ana, your plan is Pro.");
    assert.equal(mailer.transport, "smtp");
  });

  test("smtps (TLS from the first byte) with AUTH LOGIN", async () => {
    const server = await start({ implicitTls: true, auth: ["LOGIN"], user: "u", pass: "p" });
    const mailer = mail({ smtp: { host: "localhost", port: server.port, secure: true, user: "u", pass: "p", ca: [CA] }, from: "no-reply@acme.com" });
    await mailer.send({ to: "ana@example.com", subject: "Hi", text: "x" });
    assert.deepEqual(server.sessions[0]!.commands.slice(0, 2), [`EHLO ${server.sessions[0]!.commands[0]!.slice(5)}`, "AUTH LOGIN"]);
    assert.ok(server.sessions[0]!.data);
  });

  test("a server on this machine without STARTTLS (Mailpit, say) works by default; with requireTLS it is refused", async () => {
    const server = await start({});
    await mail({ smtp: `smtp://127.0.0.1:${server.port}`, from: "no-reply@acme.com" }).send({ to: "a@example.com", subject: "Hi", text: "x" });
    assert.ok(server.sessions[0]!.data);
    await assert.rejects(mail({ smtp: { host: "127.0.0.1", port: server.port, requireTLS: true }, from: "no-reply@acme.com" }).send({ to: "a@example.com", subject: "Hi", text: "x" }), (e: unknown) => {
      assert.ok(isCode("IL6071")(e));
      assert.equal(((e as InferloError).details as { stage: string }).stage, "starttls");
      return true;
    });
    assert.equal(server.sessions[1]!.data, undefined);
  });

  test("an untrusted certificate is refused before anything is sent", async () => {
    const server = await start({ starttls: true, auth: ["PLAIN"], user: "u", pass: "p" });
    await assert.rejects(mail({ smtp: { host: "localhost", port: server.port, user: "u", pass: "p", requireTLS: true }, from: "no-reply@acme.com" }).send({ to: "a@example.com", subject: "Hi", text: "x" }), (e: unknown) => {
      assert.ok(isCode("IL6071")(e));
      assert.match((e as InferloError).fix!, /certificate/);
      return true;
    });
    assert.ok(!server.sessions[0]!.commands.some((c) => c.startsWith("AUTH")));
  });

  test("a wrong password is IL6071 at auth, and the password is in no error", async () => {
    const server = await start({ starttls: true, auth: ["PLAIN"], user: "u", pass: "right" });
    await assert.rejects(mail({ smtp: { host: "localhost", port: server.port, user: "u", pass: "wrong-pass-123", ca: CA }, from: "no-reply@acme.com" }).send({ to: "a@example.com", subject: "Hi", text: "x" }), (e: unknown) => {
      const error = e as InferloError;
      assert.ok(isCode("IL6071")(e));
      assert.equal(error.status, 502);
      assert.equal(error.expose, false);
      assert.deepEqual(error.details, { stage: "auth", code: 535, response: "535 5.7.8 bad credentials", permanent: true });
      const all = JSON.stringify({ message: error.message, fix: error.fix, details: error.details });
      assert.ok(!all.includes("wrong-pass-123") && !all.includes(btoa("\u0000u\u0000wrong-pass-123")));
      return true;
    });
  });

  test("a refused recipient sends the message to nobody", async () => {
    const server = await start({});
    await assert.rejects(mail({ smtp: `smtp://localhost:${server.port}`, from: "no-reply@acme.com" }).send({ to: ["a@example.com", "refused@example.com"], subject: "Hi", text: "x" }), (e: unknown) => isCode("IL6071")(e) && ((e as InferloError).details as { stage: string }).stage === "recipient");
    assert.equal(server.sessions[0]!.data, undefined);
    assert.ok(!server.sessions[0]!.commands.includes("DATA"));
  });

  test("no server, or one that never answers, is IL6071 within timeoutMs", async () => {
    const closed = await smtpServer({});
    const port = closed.port;
    await closed.close();
    await assert.rejects(mail({ smtp: `smtp://127.0.0.1:${port}`, from: "no-reply@acme.com" }).send({ to: "a@example.com", subject: "Hi", text: "x" }), (e: unknown) => isCode("IL6071")(e) && ((e as InferloError).details as { stage: string }).stage === "connect");
    const silent = await start({ greet: false });
    const started = Date.now();
    await assert.rejects(mail({ smtp: { host: "127.0.0.1", port: silent.port, timeoutMs: 200 }, from: "no-reply@acme.com" }).send({ to: "a@example.com", subject: "Hi", text: "x" }), isCode("IL6071"));
    assert.ok(Date.now() - started < 5000);
  });

  test("dot-stuffing doubles a leading dot on every line", () => {
    assert.equal(dotStuff(".a\r\nb\r\n.\r\n..c"), "..a\r\nb\r\n..\r\n...c\r\n.\r\n");
  });
});
