/**
 * Email: ctx.mail in routes, sockets and jobs, app.mail everywhere else.
 *
 *   export const mailer = mail({
 *     smtp: settings.SMTP_URL,                 // "smtps://user:pass@smtp.example.com" (465) or "smtp://...:587" (STARTTLS)
 *     from: "Acme <no-reply@acme.com>",
 *     templates: {
 *       welcome: { subject: "Welcome, {{name}}", text: "Hi {{name}}, ...", html: "<p>Hi {{name}}, ...</p>" },
 *     },
 *   });
 *   createApp({ mail: mailer, ... });
 *
 *   await mail.send({ to: user.email, template: "welcome", data: { name: user.name } });
 *   await mail.send({ to: "ops@acme.com", subject: "Export ready", text: "...", attachments: [{ filename, content }] });
 *
 * Messages are built here (MIME, UTF-8, base64) with Web APIs only. The SMTP client lives in smtp.ts and loads
 * node:net and node:tls on first use, so it runs on Node.js, Bun and Deno. Tests use memoryMail(), which keeps the
 * messages instead of sending them; any other service plugs in as a MailTransport that receives the finished message.
 */
import { InferloError } from "./errors.ts";

/** A template: {{name}} placeholders in the subject, text and html. Values are HTML-escaped in html. */
export interface MailTemplate {
  subject: string;
  text?: string;
  html?: string;
}

/** SMTP server settings, or an smtp:// / smtps:// URL in mail({ smtp }). */
export interface SmtpOptions {
  host: string;
  /** Default 465 with secure: true, else 587. */
  port?: number;
  /** TLS from the first byte (port 465, smtps://). Default false: plain connection upgraded with STARTTLS. */
  secure?: boolean;
  user?: string;
  pass?: string;
  /**
   * Refuse to send without TLS. Default true, except for servers on this machine (localhost, 127.0.0.1, ::1), such
   * as Mailpit in development. STARTTLS is always used when the server offers it.
   */
  requireTLS?: boolean;
  /** Extra trusted CA certificates (PEM), for a server with a private CA. Certificates are always verified. */
  ca?: string | string[];
  /** Name sent in EHLO. Default: this machine's host name. */
  name?: string;
  /** Milliseconds to wait for each server reply. Default 30000. */
  timeoutMs?: number;
}

/** An attachment: content is text, bytes or a Blob (a File from t.file() too). */
export interface MailAttachment {
  filename: string;
  content: string | Uint8Array | ArrayBuffer | Blob;
  /** Media type. Default: the Blob's type, else application/octet-stream. */
  type?: string;
}

interface MessageBase {
  /** One address or several: "ana@example.com" or "Ana Lima <ana@example.com>". */
  to: string | string[];
  cc?: string | string[];
  /** Receive the message without being listed in its headers. */
  bcc?: string | string[];
  /** Default: mail({ replyTo }). */
  replyTo?: string;
  /** Default: mail({ from }). */
  from?: string;
  attachments?: MailAttachment[];
  /** Extra headers, such as { "List-Unsubscribe": "<https://acme.com/unsubscribe/42>" }. */
  headers?: Record<string, string>;
}

type Placeholders<S> = S extends `${string}{{${infer V}}}${infer Rest}` ? V | Placeholders<Rest> : never;
type TemplateVariables<T> = T extends MailTemplate ? Placeholders<T["subject"]> | Placeholders<T["text"]> | Placeholders<T["html"]> : never;
/** The data a template needs: its {{names}}, or any names when its texts are not literal types. */
type TemplateData<T> = T extends MailTemplate
  ? string extends T["subject"] | NonNullable<T["text"]> | NonNullable<T["html"]>
    ? Record<string, string | number>
    : { [V in TemplateVariables<T>]: string | number }
  : never;

/** A message with its own subject and body, or one of the mailer's templates with its variables. */
export type MailMessage<Templates extends Record<string, MailTemplate> = Record<string, MailTemplate>> =
  | (MessageBase & { subject: string; text?: string; html?: string; template?: never; data?: never })
  | (string extends keyof Templates
      ? MessageBase & { template: string; data: Record<string, string | number>; subject?: never; text?: never; html?: never }
      : {
      [K in keyof Templates & string]: MessageBase & {
        template: K;
        data: TemplateData<Templates[K]>;
        subject?: never;
        text?: never;
        html?: never;
      };
    }[keyof Templates & string]);

/** What mail.send() resolves to. */
export interface SentMailInfo {
  /** The Message-ID header, without angle brackets. */
  messageId: string;
  /** Every recipient (to, cc and bcc), the addresses only. */
  accepted: string[];
}

/** A finished message handed to a MailTransport. */
export interface OutgoingMail {
  /** SMTP envelope: the sender address and every recipient address (to, cc and bcc). */
  envelope: { from: string; to: string[] };
  messageId: string;
  /** The whole message (RFC 5322, CRLF line ends, 7-bit ASCII), ready for SMTP or an HTTP API that takes raw MIME. */
  raw: string;
  /** The same message as fields, for assertions and APIs that take fields. Template variables are filled in. */
  message: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo?: string;
    subject: string;
    text?: string;
    html?: string;
    attachments: { filename: string; type: string; content: Uint8Array }[];
    headers: Record<string, string>;
  };
}

/** Where messages go. smtp sends them; memoryMail() keeps them; implement it for an email API. */
export interface MailTransport {
  /** Shown in describe() and as app.mail.transport, for example "smtp" or "memory". */
  readonly name: string;
  send(mail: OutgoingMail): Promise<void>;
}

/** memoryMail(): a transport that keeps every message in sent, for tests. */
export interface MemoryMailTransport extends MailTransport {
  readonly sent: OutgoingMail[];
}

export interface MailOptions<Templates extends Record<string, MailTemplate>> {
  /** An SMTP server: "smtps://user:pass@smtp.example.com", "smtp://user:pass@smtp.example.com:587" or SmtpOptions. */
  smtp?: string | SmtpOptions;
  /** Instead of smtp: memoryMail() in tests, or your own MailTransport. */
  transport?: MailTransport;
  /** The default sender: "Acme <no-reply@acme.com>". */
  from: string;
  /** The default Reply-To. */
  replyTo?: string;
  templates?: Templates;
}

/** The mailer mail() returns: pass it to createApp({ mail }), or call send() directly. */
export interface Mailer<Templates extends Record<string, MailTemplate> = Record<string, MailTemplate>> {
  /** "smtp", "memory" or your transport's name. */
  readonly transport: string;
  /** The template names. */
  readonly templates: string[];
  /** Build and send one message. Throws IL6070 for an invalid message and IL6071 when the server refuses it. */
  send(message: MailMessage<Templates>): Promise<SentMailInfo>;
}

/** ctx.mail and app.mail. Register { mail: typeof mailer } types the template names and their variables. */
export type Mail<Templates extends Record<string, MailTemplate> = Record<string, MailTemplate>> = Mailer<Templates>;

const invalidOptions = (message: string, fix: string): InferloError => new InferloError("IL6068", message, { fix });
const invalidMessage = (message: string, fix: string): InferloError => new InferloError("IL6070", message, { fix });

const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";
const ADDRESS = new RegExp(`^[${ATEXT}]+(\\.[${ATEXT}]+)*@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$`);
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!-9;-~]+$/;
const RESERVED_HEADERS = new Set(["from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version", "content-type", "content-transfer-encoding"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

interface Mailbox {
  name?: string;
  address: string;
}

/** Parses "ana@example.com" or "Ana Lima <ana@example.com>". */
function mailbox(value: unknown, field: string, fail: (message: string, fix: string) => InferloError): Mailbox {
  if (typeof value !== "string" || !value.trim()) throw fail(`${field} must be an email address, got ${JSON.stringify(value)}.`, 'Use "ana@example.com" or "Ana Lima <ana@example.com>".');
  if (/[\r\n]/.test(value)) throw fail(`${field} contains a line break.`, "Remove line breaks from addresses; they could add headers to the message.");
  const text = value.trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(text);
  const address = (named ? named[2]! : text).trim();
  let name = named ? named[1]!.trim() : undefined;
  if (name && name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  if (!ADDRESS.test(address) || address.length > 254) {
    throw fail(`${field} has the invalid email address ${JSON.stringify(address)}.`, 'Use a plain ASCII address such as "ana@example.com" (international domains in their xn-- form).');
  }
  if (name && /[<>]/.test(name)) throw fail(`${field} has a name with < or >: ${JSON.stringify(name)}.`, 'Write "Name <address>" with one address.');
  return { name: name || undefined, address };
}

function list(value: string | string[] | undefined, field: string): Mailbox[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item, i) => mailbox(item, Array.isArray(value) ? `${field}[${i}]` : field, invalidMessage));
}

function placeholders(text: string, where: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/\{\{(.*?)\}\}/g)) {
    const name = match[1]!;
    if (!VARIABLE.test(name)) throw invalidOptions(`${where} has the placeholder "{{${name}}}", which is not a variable name.`, "Use {{name}} with letters, digits and underscores only, no spaces.");
    names.push(name);
  }
  return names;
}

function checkTemplates(templates: unknown): Map<string, { template: MailTemplate; variables: Set<string> }> {
  const out = new Map<string, { template: MailTemplate; variables: Set<string> }>();
  if (templates === undefined) return out;
  if (!templates || typeof templates !== "object" || Array.isArray(templates)) throw invalidOptions("mail({ templates }) must be an object of templates.", 'Use templates: { welcome: { subject: "Welcome, {{name}}", text: "Hi {{name}}" } }.');
  for (const [name, template] of Object.entries(templates as Record<string, unknown>)) {
    const t = template as MailTemplate;
    if (!t || typeof t !== "object" || typeof t.subject !== "string" || !t.subject) throw invalidOptions(`Mail template "${name}" needs a subject.`, `Use ${name}: { subject: "...", text: "..." }.`);
    if (t.text !== undefined && typeof t.text !== "string") throw invalidOptions(`Mail template "${name}" has a text that is not a string.`, "Set text to a string, or leave it out.");
    if (t.html !== undefined && typeof t.html !== "string") throw invalidOptions(`Mail template "${name}" has an html that is not a string.`, "Set html to a string, or leave it out.");
    if (!t.text && !t.html) throw invalidOptions(`Mail template "${name}" has no text and no html.`, "Give it a text body, an html body, or both.");
    const unknownKey = Object.keys(t).find((k) => k !== "subject" && k !== "text" && k !== "html");
    if (unknownKey) throw invalidOptions(`Mail template "${name}" has the unknown key ${unknownKey}.`, "A template has subject, text and html.");
    const variables = new Set([...placeholders(t.subject, `Mail template "${name}" subject`), ...placeholders(t.text ?? "", `Mail template "${name}" text`), ...placeholders(t.html ?? "", `Mail template "${name}" html`)]);
    out.set(name, { template: { subject: t.subject, text: t.text, html: t.html }, variables });
  }
  return out;
}

/** Resolved SMTP settings (also used by smtp.ts). */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  requireTLS: boolean;
  ca?: string[];
  name?: string;
  timeoutMs: number;
}

/** Parses mail({ smtp }) into SmtpConfig. Raises IL6068 for anything invalid. */
export function smtpConfig(smtp: string | SmtpOptions): SmtpConfig {
  let options: SmtpOptions;
  if (typeof smtp === "string") {
    let url: URL;
    try {
      url = new URL(smtp);
    } catch {
      throw invalidOptions("mail({ smtp }) is not a valid URL.", 'Use "smtps://user:pass@smtp.example.com" (port 465) or "smtp://user:pass@smtp.example.com:587" (STARTTLS); encode special characters in the password with encodeURIComponent.');
    }
    if (url.protocol !== "smtp:" && url.protocol !== "smtps:") throw invalidOptions(`mail({ smtp }) must start with smtp:// or smtps://, got ${url.protocol}//.`, 'Use "smtps://user:pass@smtp.example.com" or "smtp://user:pass@smtp.example.com:587".');
    if ([...url.searchParams.keys()].length || (url.pathname && url.pathname !== "/")) throw invalidOptions("mail({ smtp }) URLs take no path or query.", "Use the object form, mail({ smtp: { host, port, user, pass, requireTLS } }), for other settings.");
    let user: string | undefined;
    let pass: string | undefined;
    try {
      user = url.username ? decodeURIComponent(url.username) : undefined;
      pass = url.password ? decodeURIComponent(url.password) : undefined;
    } catch {
      throw invalidOptions("mail({ smtp }) has a user name or password that is not valid URL encoding.", "Encode them with encodeURIComponent, or use the object form with user and pass.");
    }
    options = { host: url.hostname, port: url.port ? Number(url.port) : undefined, secure: url.protocol === "smtps:", user, pass };
  } else if (smtp && typeof smtp === "object") {
    options = smtp;
    const unknownKey = Object.keys(smtp).find((k) => !["host", "port", "secure", "user", "pass", "requireTLS", "ca", "name", "timeoutMs"].includes(k));
    if (unknownKey) throw invalidOptions(`mail({ smtp }) has the unknown option ${unknownKey}.`, "SMTP options are host, port, secure, user, pass, requireTLS, ca, name and timeoutMs.");
  } else {
    throw invalidOptions("mail({ smtp }) must be an smtp:// or smtps:// URL or { host, port, user, pass }.", 'Use mail({ smtp: settings.SMTP_URL, from: "Acme <no-reply@acme.com>" }).');
  }
  const host = typeof options.host === "string" ? options.host.trim() : "";
  if (!host || /[\s/]/.test(host)) throw invalidOptions("mail({ smtp }) needs a host.", 'Set host, for example "smtp.example.com".');
  const secure = options.secure ?? false;
  if (typeof secure !== "boolean") throw invalidOptions("mail({ smtp: { secure } }) must be true or false.", "Use secure: true for port 465 (TLS from the start), false for STARTTLS.");
  const port = options.port ?? (secure ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalidOptions(`mail({ smtp }) has the invalid port ${String(options.port)}.`, "Use 465 with secure: true, or 587 (STARTTLS).");
  if ((options.user === undefined) !== (options.pass === undefined) || (options.user !== undefined && (typeof options.user !== "string" || typeof options.pass !== "string" || !options.user))) {
    throw invalidOptions("mail({ smtp }) needs both user and pass, or neither.", "Set both, for example from settings.SMTP_USER and settings.SMTP_PASS.");
  }
  const loopback = LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);
  const requireTLS = options.requireTLS ?? !loopback;
  if (typeof requireTLS !== "boolean") throw invalidOptions("mail({ smtp: { requireTLS } }) must be true or false.", "Leave it out: TLS is required except for servers on this machine.");
  const ca = options.ca === undefined ? undefined : Array.isArray(options.ca) ? options.ca : [options.ca];
  if (ca && !ca.every((c) => typeof c === "string" && c.includes("BEGIN CERTIFICATE"))) throw invalidOptions("mail({ smtp: { ca } }) must be PEM certificates.", 'Pass the CA certificate text ("-----BEGIN CERTIFICATE-----...").');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw invalidOptions("mail({ smtp: { timeoutMs } }) must be a positive whole number of milliseconds.", "Leave it out for 30000.");
  if (options.name !== undefined && (typeof options.name !== "string" || !/^[A-Za-z0-9.-]+$/.test(options.name))) throw invalidOptions("mail({ smtp: { name } }) must be a host name.", 'Use your host name, for example "api.acme.com".');
  return { host: host.replace(/^\[|\]$/g, ""), port, secure, user: options.user, pass: options.pass, requireTLS, ca, name: options.name, timeoutMs };
}

function smtpTransport(config: SmtpConfig): MailTransport {
  return {
    name: "smtp",
    async send(mail) {
      const { sendSmtp } = await import("./smtp.ts");
      await sendSmtp(config, mail.envelope, mail.raw);
    },
  };
}

/** A transport that keeps messages in .sent instead of sending them. Use it in tests. */
export function memoryMail(): MemoryMailTransport {
  const sent: OutgoingMail[] = [];
  return {
    name: "memory",
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

/**
 * An email sender with templates. Pass it to createApp({ mail }) for ctx.mail and app.mail. Options are checked
 * here, so a wrong URL, address or template fails at startup with IL6068.
 */
export function mail<const Templates extends Record<string, MailTemplate> = {}>(options: MailOptions<Templates>): Mailer<Templates> {
  if (!options || typeof options !== "object") throw invalidOptions("mail() needs options.", 'Use mail({ smtp: settings.SMTP_URL, from: "Acme <no-reply@acme.com>" }).');
  const unknownKey = Object.keys(options).find((k) => !["smtp", "transport", "from", "replyTo", "templates"].includes(k));
  if (unknownKey) throw invalidOptions(`mail() has the unknown option ${unknownKey}.`, "mail() takes smtp or transport, from, replyTo and templates.");
  if ((options.smtp === undefined) === (options.transport === undefined)) {
    throw invalidOptions(options.smtp === undefined ? "mail() needs smtp or transport." : "mail() takes smtp or transport, not both.", "Use mail({ smtp: settings.SMTP_URL, from }) in the app, and mail({ transport: memoryMail(), from }) in tests.");
  }
  let transport: MailTransport;
  if (options.transport !== undefined) {
    const t = options.transport as Partial<MailTransport>;
    if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name || typeof t.send !== "function") throw invalidOptions("mail({ transport }) must have a name and a send(mail) function.", "Use memoryMail() in tests, or { name: \"my-api\", send: async (mail) => { ... } }.");
    transport = t as MailTransport;
  } else {
    transport = smtpTransport(smtpConfig(options.smtp!));
  }
  const from = mailbox(options.from, "mail({ from })", invalidOptions);
  const replyTo = options.replyTo === undefined ? undefined : mailbox(options.replyTo, "mail({ replyTo })", invalidOptions);
  const templates = checkTemplates(options.templates);

  return {
    transport: transport.name,
    templates: [...templates.keys()],
    async send(message) {
      const outgoing = await build(message as MailMessage, { from, replyTo, templates });
      await transport.send(outgoing);
      return { messageId: outgoing.messageId, accepted: outgoing.envelope.to };
    },
  };
}

/** Checks createApp({ mail }). */
export function checkMailer(value: unknown): Mailer | undefined {
  if (value === undefined) return undefined;
  const m = value as Partial<Mailer>;
  if (!m || typeof m !== "object" || typeof m.send !== "function" || typeof m.transport !== "string" || !Array.isArray(m.templates)) {
    throw invalidOptions("createApp({ mail }) must be a mailer from mail().", 'Use createApp({ mail: mail({ smtp: settings.SMTP_URL, from: "Acme <no-reply@acme.com>" }) }).');
  }
  return m as Mailer;
}

/** ctx.mail and app.mail on top of a mailer (or one that throws IL6069 when there is none). */
export function createMail(mailer: Mailer | undefined): Mail & { readonly transport: string | null } {
  if (mailer) return mailer;
  return {
    transport: null,
    templates: [],
    async send() {
      throw new InferloError("IL6069", "ctx.mail was used, but createApp has no mail option.", {
        fix: 'Add createApp({ mail: mail({ smtp: settings.SMTP_URL, from: "Acme <no-reply@acme.com>" }) }), or mail({ transport: memoryMail(), from }) in tests.',
      });
    },
  } as unknown as Mail & { readonly transport: string | null };
}

// ---------------------------------------------------------------------------------------------------------------
// Building the message

const encoder = new TextEncoder();

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fill(text: string, data: Record<string, unknown>, html: boolean): string {
  return text.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name: string) => {
    const value = String(data[name]);
    return html ? escapeHtml(value) : value;
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** base64 in lines of 76 characters. */
function base64Lines(bytes: Uint8Array): string {
  return (base64(bytes).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/** RFC 2047 encoded words of at most 75 characters, never splitting a character. */
function encodedWords(value: string): string[] {
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (encoder.encode(chunk + char).length > 39) {
      words.push(`=?UTF-8?B?${base64(encoder.encode(chunk))}?=`);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk || !words.length) words.push(`=?UTF-8?B?${base64(encoder.encode(chunk))}?=`);
  return words;
}

/** An unstructured header value (Subject): plain when short ASCII, else encoded words folded over lines. */
function headerText(value: string): string {
  if (isAscii(value) && value.length <= 900) return value;
  return encodedWords(value).join("\r\n ");
}

function formatMailbox(box: Mailbox): string {
  if (!box.name) return box.address;
  if (!isAscii(box.name)) return `${encodedWords(box.name).join("\r\n ")}\r\n <${box.address}>`;
  if (/^[A-Za-z0-9 !#$%&'*+/=?^_`{|}~-]+$/.test(box.name)) return `${box.name} <${box.address}>`;
  return `"${box.name.replace(/(["\\])/g, "\\$1")}" <${box.address}>`;
}

/** Address lists, folded so no line gets long. */
function formatList(boxes: Mailbox[]): string {
  return boxes.map(formatMailbox).join(",\r\n ");
}

function date(now: Date): string {
  return now.toUTCString().replace(/GMT$/, "+0000");
}

/** Content-Type / Content-Disposition parameters for a file name (RFC 2231 for non-ASCII names). */
function fileParameter(key: string, filename: string): string {
  if (isAscii(filename) && !/["\\]/.test(filename)) return `${key}="${filename}"`;
  const encoded = [...encoder.encode(filename)].map((b) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");
  return `${key}*=UTF-8''${encoded}`;
}

const boundary = () => `inferlo-${crypto.randomUUID().replace(/-/g, "")}`;

function part(type: string, bytes: Uint8Array, extra: string[] = []): string {
  return [`Content-Type: ${type.replace(/; /g, ";\r\n ")}`, "Content-Transfer-Encoding: base64", ...extra.map((h) => h.replace(/; /g, ";\r\n ")), "", base64Lines(bytes)].join("\r\n");
}

function multipart(subtype: string, parts: string[]): string {
  const b = boundary();
  return [`Content-Type: multipart/${subtype};\r\n boundary="${b}"`, "", ...parts.map((p) => `--${b}\r\n${p}`), `--${b}--`].join("\r\n");
}

async function attachmentBytes(content: MailAttachment["content"]): Promise<Uint8Array> {
  if (typeof content === "string") return encoder.encode(content);
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof Blob !== "undefined" && content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
  throw invalidMessage("An attachment's content must be a string, Uint8Array, ArrayBuffer or Blob.", "Pass the file's bytes, text, or a File from t.file().");
}

interface Defaults {
  from: Mailbox;
  replyTo?: Mailbox;
  templates: Map<string, { template: MailTemplate; variables: Set<string> }>;
}

async function build(message: MailMessage, defaults: Defaults, now = new Date()): Promise<OutgoingMail> {
  if (!message || typeof message !== "object") throw invalidMessage("mail.send() needs a message.", 'Use mail.send({ to, subject, text }) or mail.send({ to, template: "welcome", data }).');
  const m = message as MessageBase & { subject?: unknown; text?: unknown; html?: unknown; template?: unknown; data?: unknown };
  let subject: string;
  let text: string | undefined;
  let html: string | undefined;
  if (m.template !== undefined) {
    const entry = typeof m.template === "string" ? defaults.templates.get(m.template) : undefined;
    if (!entry) {
      const names = [...defaults.templates.keys()];
      throw invalidMessage(`There is no mail template ${JSON.stringify(m.template)}.`, names.length ? `Use one of: ${names.join(", ")}.` : "Add it to mail({ templates }).");
    }
    if (m.subject !== undefined || m.text !== undefined || m.html !== undefined) throw invalidMessage("A message with a template takes no subject, text or html.", "Change the template, or send without template.");
    const data = (m.data ?? {}) as Record<string, unknown>;
    if (!data || typeof data !== "object") throw invalidMessage(`Mail template "${m.template}" needs data.`, `Pass data: { ${[...entry.variables].map((v) => `${v}: ...`).join(", ")} }.`);
    const missing = [...entry.variables].filter((v) => typeof data[v] !== "string" && typeof data[v] !== "number");
    if (missing.length) throw invalidMessage(`Mail template "${m.template}" needs ${missing.map((v) => `{{${v}}}`).join(", ")} in data.`, `Pass data: { ${missing.map((v) => `${v}: ...`).join(", ")} } as strings or numbers.`);
    subject = fill(entry.template.subject, data, false);
    text = entry.template.text === undefined ? undefined : fill(entry.template.text, data, false);
    html = entry.template.html === undefined ? undefined : fill(entry.template.html, data, true);
  } else {
    if (typeof m.subject !== "string" || !m.subject.trim()) throw invalidMessage("mail.send() needs a subject.", 'Use mail.send({ to, subject: "...", text: "..." }), or a template.');
    if (m.text !== undefined && typeof m.text !== "string") throw invalidMessage("The text of a message must be a string.", "Pass text as a string.");
    if (m.html !== undefined && typeof m.html !== "string") throw invalidMessage("The html of a message must be a string.", "Pass html as a string.");
    if (!m.text && !m.html) throw invalidMessage("mail.send() needs text, html or both.", "Add text (plain text) and, if you like, html.");
    subject = m.subject;
    text = m.text as string | undefined;
    html = m.html as string | undefined;
  }
  // A line break in a subject (from template data, say) must never start a new header.
  subject = subject.replace(/[\r\n]+/g, " ").trim();

  const from = m.from === undefined ? defaults.from : mailbox(m.from, "from", invalidMessage);
  const replyTo = m.replyTo === undefined ? defaults.replyTo : mailbox(m.replyTo, "replyTo", invalidMessage);
  const to = list(m.to, "to");
  const cc = list(m.cc, "cc");
  const bcc = list(m.bcc, "bcc");
  if (!to.length) throw invalidMessage("mail.send() needs at least one address in to.", 'Use to: "ana@example.com" or to: ["ana@example.com", "bo@example.com"].');

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(m.headers ?? {})) {
    if (!HEADER_NAME.test(name)) throw invalidMessage(`The header name ${JSON.stringify(name)} is not valid.`, "Use letters, digits and dashes, such as List-Unsubscribe.");
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw invalidMessage(`The header ${name} is set by Inferlo.`, "Use the message fields (to, cc, bcc, replyTo, subject, from) instead.");
    if (typeof value !== "string" || /[\r\n]/.test(value) || !isAscii(value)) throw invalidMessage(`The header ${name} must be one line of ASCII text.`, "Remove line breaks and non-ASCII characters from header values.");
    headers[name] = value;
  }

  const attachments: OutgoingMail["message"]["attachments"] = [];
  for (const [i, a] of (m.attachments ?? []).entries()) {
    if (!a || typeof a.filename !== "string" || !a.filename || /[\r\n/\\]/.test(a.filename)) throw invalidMessage(`attachments[${i}] needs a filename without line breaks or slashes.`, 'Use { filename: "report.pdf", content }.');
    const type = a.type ?? (typeof Blob !== "undefined" && a.content instanceof Blob && a.content.type ? a.content.type.split(";")[0]!.trim() : "application/octet-stream");
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type)) throw invalidMessage(`attachments[${i}] has the invalid media type ${JSON.stringify(type)}.`, 'Use a plain media type such as "application/pdf".');
    attachments.push({ filename: a.filename, type: type.toLowerCase(), content: await attachmentBytes(a.content) });
  }

  const domain = from.address.slice(from.address.lastIndexOf("@") + 1);
  const messageId = `${crypto.randomUUID()}@${domain}`;
  const head = [`From: ${formatMailbox(from)}`, `To: ${formatList(to)}`];
  if (cc.length) head.push(`Cc: ${formatList(cc)}`);
  if (replyTo) head.push(`Reply-To: ${formatMailbox(replyTo)}`);
  head.push(`Subject: ${headerText(subject)}`, `Date: ${date(now)}`, `Message-ID: <${messageId}>`, "MIME-Version: 1.0");
  for (const [name, value] of Object.entries(headers)) head.push(`${name}: ${value}`);

  const bodies: string[] = [];
  if (text !== undefined && text !== "") bodies.push(part("text/plain; charset=utf-8", encoder.encode(text.replace(/\r?\n/g, "\r\n"))));
  if (html !== undefined && html !== "") bodies.push(part("text/html; charset=utf-8", encoder.encode(html.replace(/\r?\n/g, "\r\n"))));
  let body = bodies.length === 1 ? bodies[0]! : multipart("alternative", bodies);
  if (attachments.length) {
    body = multipart("mixed", [
      body,
      ...attachments.map((a) => part(`${a.type}; ${fileParameter("name", a.filename)}`, a.content, [`Content-Disposition: attachment; ${fileParameter("filename", a.filename)}`])),
    ]);
  }
  const raw = `${head.join("\r\n")}\r\n${body}\r\n`;

  const recipients = [...new Set([...to, ...cc, ...bcc].map((b) => b.address))];
  const show = (b: Mailbox) => (b.name ? `${b.name} <${b.address}>` : b.address);
  return {
    envelope: { from: from.address, to: recipients },
    messageId,
    raw,
    message: {
      from: show(from),
      to: to.map(show),
      cc: cc.map(show),
      bcc: bcc.map(show),
      ...(replyTo ? { replyTo: show(replyTo) } : {}),
      subject,
      ...(text !== undefined ? { text } : {}),
      ...(html !== undefined ? { html } : {}),
      attachments,
      headers,
    },
  };
}
