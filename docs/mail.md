# Email

`ctx.mail` sends email through the mailer chosen in `createApp({ mail })`: an SMTP server in production, an in-memory outbox in tests. It works the same in routes, WebSocket handlers and jobs, and as `app.mail` everywhere else. Templates are part of the mailer, with typed `{{variables}}`.

```ts
// src/mail.ts
import { mail } from "@browserlessapi/inferlo";
import { settings } from "./config.ts";

export const mailer = mail({
  smtp: settings.SMTP_URL, // "smtps://user:pass@smtp.example.com" or "smtp://user:pass@smtp.example.com:587"
  from: "Acme <no-reply@acme.com>",
  templates: {
    welcome: {
      subject: "Welcome to Acme, {{name}}",
      text: "Hi {{name}},\n\nYour {{plan}} account is ready.",
      html: "<p>Hi {{name}},</p><p>Your <b>{{plan}}</b> account is ready.</p>",
    },
  },
});
```

```ts
// src/app.ts
import { mailer } from "./mail.ts";

export const app = createApp({ models, routes, jobs: [jobs], mail: mailer, ... });
```

Send from a job, so a slow or unavailable mail server never slows down a request and failed sends are retried:

```ts
// src/jobs.ts
import { job, t } from "@browserlessapi/inferlo";

export const sendWelcome = job("send-welcome", { input: t.object({ userId: t.uuid() }), retries: 5 }).handle(async ({ input, db, mail }) => {
  const user = await db.users.get(input.userId);
  await mail.send({ to: user.email, template: "welcome", data: { name: user.name, plan: "Free" } });
});

// in a route: await jobs.enqueue(sendWelcome, { userId: user.id });
```

`await mail.send(...)` in a route also works: it sends before the response, and a failure is a 500 (IL6071).

## Messages

| Field | |
|---|---|
| `to` | One address or a list: `"ana@example.com"` or `"Ana Lima <ana@example.com>"`. Required. |
| `cc`, `bcc` | One address or a list. `bcc` recipients get the message but are never in its headers. |
| `subject`, `text`, `html` | A message without a template needs `subject` and `text`, `html` or both (both send `multipart/alternative`). |
| `template`, `data` | A template name and its variables (strings or numbers), instead of `subject`, `text` and `html`. |
| `from`, `replyTo` | Override the mailer's `from` and `replyTo` for one message. |
| `attachments` | `[{ filename, content, type }]`: `content` is text, a `Uint8Array`, an `ArrayBuffer` or a `Blob` (a `File` from `t.file()` too); `type` defaults to the `Blob`'s type, else `application/octet-stream`. |
| `headers` | Extra headers, for example `{ "List-Unsubscribe": "<https://acme.com/unsubscribe/42>" }`. One line of ASCII each; the headers Inferlo writes (From, To, Subject, Date, Message-ID and so on) cannot be replaced. |

`send` resolves to `{ messageId, accepted }`: the `Message-ID` (without angle brackets, at the domain of `from`) and every recipient address.

- Messages are UTF-8: non-ASCII subjects, names and file names are encoded (RFC 2047 and RFC 2231), bodies and attachments are base64, and every line of the message stays short, so any SMTP server accepts it.
- Addresses are checked: plain ASCII addresses (international domains in their `xn--` form), at most one per string. An address, name or header with a line break is refused, so user input can never add a `Bcc:` header. A line break in a filled-in subject becomes a space.
- An invalid message is IL6070 and nothing is sent.

## Templates

- `{{name}}` placeholders in `subject`, `text` and `html`, letters, digits and underscores only (no spaces inside the braces). Every placeholder must be in `data`, or the send fails with IL6070.
- Values are HTML-escaped in `html` (`<` becomes `&lt;`), and inserted as they are in `subject` and `text`.
- With the templates written inline in `mail({ templates })`, TypeScript knows the template names and each template's variables: a missing variable or an unknown template is a type error. For `ctx.mail` in routes and jobs, add the mailer to `Register` (`interface Register { mail: typeof mailer }`, next to `models` and `user`); without it `ctx.mail` accepts any template name and data, checked when sending.
- Invalid templates (no subject, no body, a placeholder that is not a name) fail at startup with IL6068.

## SMTP

`smtp` is a URL or an object:

| URL | Connection |
|---|---|
| `smtps://user:pass@smtp.example.com` | TLS from the first byte, port 465 unless given. |
| `smtp://user:pass@smtp.example.com:587` | Plain connection upgraded with STARTTLS, port 587 unless given. |
| `smtp://localhost:1025` | A development server on this machine (Mailpit, MailHog, smtp4dev), without TLS. |

Encode special characters in the user name and password with `encodeURIComponent` (an `@` is `%40`), or use the object form: `{ host, port, secure, user, pass, requireTLS, ca, name, timeoutMs }`.

- **TLS is required.** Without `secure`, Inferlo upgrades with STARTTLS whenever the server offers it, and refuses to send (IL6071, before logging in) when it does not, except for servers on this machine (`localhost`, `127.0.0.1`, `::1`). Set `requireTLS: false` only for a server you control on a private network.
- **Certificates are always verified** against the system's CA certificates. For a server with a private CA, pass its certificate as `ca` (PEM text, or a list). There is no option to skip verification.
- **Login** with `user` and `pass` uses AUTH PLAIN, or AUTH LOGIN when that is all the server offers. Many providers want an API key or app password here (for example SendGrid's user `apikey`, Amazon SES SMTP credentials, Postmark's server token).
- One connection per message, closed after `QUIT`. `timeoutMs` (default 30000) limits each wait for the server.
- When the server refuses any recipient, nothing is sent to anyone and `send` fails with IL6071.
- Failures are IL6071 with status 502 (shown to clients as an internal error, logged in full), with `details.stage` (`connect`, `greeting`, `ehlo`, `starttls`, `auth`, `sender`, `recipient` or `data`), the server's reply in `details.response` and `details.permanent` for 5xx replies. The password never appears in errors or logs; put `SMTP_URL` in the config's `secrets` so it is redacted too.
- SMTP needs TCP sockets: it runs on Node.js, Bun and Deno. On Cloudflare Workers, or to use a provider's HTTP API, write a [transport](#other-transports).

Outgoing port 25 is blocked by most cloud providers; use 587 or 465.

## Testing

`memoryMail()` keeps messages instead of sending them:

```ts
import { mail, memoryMail } from "@browserlessapi/inferlo";

const outbox = memoryMail();
const app = createApp({ ...options, mail: mail({ transport: outbox, from: "Acme <no-reply@acme.com>", templates }) });

await app.request("/signup", { method: "POST", json: { email: "ana@example.com", name: "Ana" } });
await app.jobs.runDue();
assert.equal(outbox.sent[0].message.subject, "Welcome to Acme, Ana");
assert.deepEqual(outbox.sent[0].envelope.to, ["ana@example.com"]);
```

Each entry of `outbox.sent` has `envelope` (`{ from, to }`, bcc included), `messageId`, `raw` (the whole message as sent over SMTP) and `message` with the fields after templates are filled in: `{ from, to, cc, bcc, replyTo, subject, text, html, attachments, headers }`.

To keep the templates in one place, export them from `src/mail.ts` (`export const templates = { ... } as const`) and use them in both mailers. In development, `smtp://localhost:1025` with [Mailpit](https://mailpit.axllent.org) shows every message in a browser.

## Other transports

`mail({ transport })` takes any object with a `name` and `send(mail)`, which receives the finished message (`envelope`, `messageId`, `raw` and `message`, as above). For an email API that accepts raw MIME:

```ts
const api = {
  name: "ses-api",
  async send({ raw }: OutgoingMail) {
    const res = await fetch("https://mail-api.example.com/v1/raw", { method: "POST", headers: { authorization: `Bearer ${settings.MAIL_API_KEY}` }, body: raw });
    if (!res.ok) throw new Error(`Mail API answered ${res.status}`);
  },
};
export const mailer = mail({ transport: api, from: "Acme <no-reply@acme.com>", templates });
```

A transport throws to fail the send (and the job attempt). `smtp` and `transport` cannot be combined; `mail()` without either is IL6068.

## Without a mail option

`ctx.mail.send()` throws IL6069 (a 500 in routes), so email is never silently dropped. `app.mail.transport` is `"smtp"`, `"memory"` or the transport's name, or `null` without a mailer, and `inferlo describe` shows it as `mail` with the template names.
