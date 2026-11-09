import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { readJson } from "@browserlessapi/inferlo/testing";

// A local SMTP server (no TLS on this machine, as with Mailpit in development) that records each message.
async function smtpServer() {
  const messages: { from: string; to: string[]; data: string }[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { from: "", to: [] as string[], data: "" };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            current = { from: "", to: [], data: "" };
            reply("250 queued");
          } else current.data += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") reply("250-test\r\n250 8BITMIME");
        else if (verb === "MAIL") (current.from = /<(.*)>/.exec(line)![1]!), reply("250 ok");
        else if (verb === "RCPT") current.to.push(/<(.*)>/.exec(line)![1]!), reply("250 ok");
        else if (verb === "DATA") (inData = true), reply("354 go");
        else if (verb === "QUIT") reply("221 bye"), socket.end();
        else reply("250 ok");
      }
    });
    socket.on("error", () => {});
    reply("220 test ESMTP");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, messages, close: () => new Promise((r) => server.close(r)) };
}

const decodeWords = (value: string) =>
  value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_, b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));

/** The decoded text bodies of a MIME message, by media type. */
function bodies(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/\r\n--[^\r\n]+/)) {
    const [head, ...rest] = part.split("\r\n\r\n");
    const type = /Content-Type:\s*(text\/(?:plain|html))/i.exec(head ?? "")?.[1]?.toLowerCase();
    if (!type) continue;
    const body = rest.join("\r\n\r\n").trim();
    out[type] = /Content-Transfer-Encoding:\s*base64/i.test(head!) ? new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0))) : body;
  }
  return out;
}

test("sign-up answers at once, and a job sends the welcome email through SMTP", async () => {
  const smtp = await smtpServer();
  process.env.SMTP_URL = `smtp://127.0.0.1:${smtp.port}`;
  try {
    const { app } = await import("../src/app.ts");
    const res = await app.request("/signup", { method: "POST", json: { email: "ana@example.com", name: "Ana & Bo" } });
    const user = await readJson(res, 201);
    assert.deepEqual({ email: user.email, name: user.name }, { email: "ana@example.com", name: "Ana & Bo" });
    assert.equal(typeof user.id, "string");
    assert.equal(smtp.messages.length, 0, "the email is sent by the job, not during the request");
    assert.ok(app.jobs.list.some((j) => j.name === "send-welcome"), "the job is registered in createApp");
    assert.equal(app.mail.transport, "smtp", "the mailer is Inferlo's mail({ smtp }), registered in createApp");

    const result = await app.jobs.runDue();
    assert.equal(result.done, 1);
    assert.equal(result.failed + result.retried, 0);
    assert.equal(smtp.messages.length, 1);
    const [message] = smtp.messages;
    assert.equal(message!.from, "no-reply@acme.dev");
    assert.deepEqual(message!.to, ["ana@example.com"]);
    const head = message!.data.split("\r\n\r\n")[0]!.replace(/\r\n[ \t]+/g, " ");
    assert.match(head, /^From: Acme <no-reply@acme\.dev>$/m);
    assert.equal(decodeWords(/^Subject: (.*)$/m.exec(head)![1]!), "Welcome to Acme, Ana & Bo");
    const parts = bodies(message!.data);
    assert.match(parts["text/plain"] ?? "", /Ana & Bo/);
    assert.match(parts["text/html"] ?? "", /Ana &amp; Bo/, "the name is HTML-escaped in the HTML body");

    const settings = (await import("../src/config.ts")).settings as Record<string, unknown>;
    assert.ok(!JSON.stringify(settings).includes(String(smtp.port)), "SMTP_URL is a secret");
  } finally {
    await smtp.close();
  }
});
