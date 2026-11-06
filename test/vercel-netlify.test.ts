import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { createApp, mockProvider, route } from "../src/index.ts";

// Vercel Functions (Node.js runtime, web-standard fetch export) and Netlify Functions 2.0 call app.fetch with a
// Request. Netlify passes its context as the second argument; Vercel sets VERCEL=1 and the X-Real-IP header, and
// keeps its waitUntil in a request context under Symbol.for("@vercel/request-context").

const VERCEL_CONTEXT = Symbol.for("@vercel/request-context");

function makeApp(later: string[] = []) {
  const limited = route.get("/limited", { auth: "public", rateLimit: { max: 1, per: "minute", by: "ip" } }).handle(() => ({ ok: true }));
  const background = route.post("/background", { auth: "public" }).handle(({ waitUntil }) => {
    waitUntil(new Promise<void>((resolve) => setTimeout(() => (later.push("done"), resolve()), 5)));
    return { queued: true };
  });
  const chat = route.get("/chat", { auth: "public" }).handle(({ ai }) => ai.stream({ model: "fast", prompt: "Hi" }).toResponse());
  return createApp({
    routes: [{ limited, background, chat }],
    ai: { providers: { mock: mockProvider({ respond: () => "Streamed answer." }) }, models: { fast: "mock:m" } },
    logging: { requests: false },
  });
}

/** The context Netlify Functions 2.0 pass to the handler, with the fields Inferlo reads. */
function netlifyContext(ip: string, waited: Promise<unknown>[] = []) {
  return { ip, requestId: "01JNETLIFYREQUEST", geo: { country: { code: "DE" } }, params: {}, waitUntil: (p: Promise<unknown>) => void waited.push(p) };
}

describe("Netlify Functions 2.0: export default app.fetch", () => {
  test("rate limits by IP use context.ip, the address Netlify sets", async () => {
    const handler = makeApp().fetch; // the handler Netlify calls with (req, context)
    const hit = (ip: string) => handler(new Request("https://site.netlify.app/limited"), netlifyContext(ip));
    assert.equal((await hit("203.0.113.7")).status, 200);
    assert.equal((await hit("203.0.113.7")).status, 429);
    assert.equal((await hit("198.51.100.4")).status, 200, "another client has its own count");
  });

  test("a spoofed X-Forwarded-For does not change the address without trustProxy", async () => {
    const app = makeApp();
    const hit = (forwarded: string) => app.fetch(new Request("https://site.netlify.app/limited", { headers: { "x-forwarded-for": forwarded } }), netlifyContext("203.0.113.7"));
    assert.equal((await hit("192.0.2.1")).status, 200);
    assert.equal((await hit("192.0.2.2")).status, 429);
  });

  test("an object with an ip but no requestId (a Worker binding named ip) is not taken for the Netlify context", async () => {
    const app = makeApp();
    const hit = (ip: string) => app.fetch(new Request("https://api.example.com/limited"), { ip });
    assert.equal((await hit("203.0.113.7")).status, 200);
    assert.equal((await hit("198.51.100.4")).status, 429, "both count as the same unknown client");
  });

  test("ctx.waitUntil hands work to context.waitUntil", async () => {
    const later: string[] = [];
    const waited: Promise<unknown>[] = [];
    const res = await makeApp(later).fetch(new Request("https://site.netlify.app/background", { method: "POST" }), netlifyContext("203.0.113.7", waited));
    assert.deepEqual(await res.json(), { queued: true });
    assert.equal(waited.length, 1);
    await waited[0];
    assert.deepEqual(later, ["done"]);
  });

  test("a streamed AI answer", async () => {
    const res = await makeApp().fetch(new Request("https://site.netlify.app/chat"), netlifyContext("203.0.113.7"));
    assert.equal(res.headers.get("content-type")?.split(";")[0], "text/event-stream");
    const text = await res.text();
    assert.equal([...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!) as string).join(""), "Streamed answer.");
  });
});

describe("Vercel Functions: export default app", () => {
  const before = process.env.VERCEL;
  afterEach(() => {
    if (before === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = before;
    delete (globalThis as Record<symbol, unknown>)[VERCEL_CONTEXT];
  });

  test("on Vercel (VERCEL=1), rate limits by IP use X-Real-IP, the address Vercel sets", async () => {
    process.env.VERCEL = "1";
    const app = makeApp();
    const hit = (ip: string) => app.fetch(new Request("https://notes.vercel.app/limited", { headers: { "x-real-ip": ip, "x-forwarded-for": ip } }));
    assert.equal((await hit("203.0.113.7")).status, 200);
    assert.equal((await hit("203.0.113.7")).status, 429);
    assert.equal((await hit("198.51.100.4")).status, 200, "another client has its own count");
  });

  test("off Vercel, a client-sent X-Real-IP is ignored", async () => {
    delete process.env.VERCEL;
    const app = makeApp();
    const hit = (ip: string) => app.fetch(new Request("https://api.example.com/limited", { headers: { "x-real-ip": ip } }));
    assert.equal((await hit("203.0.113.7")).status, 200);
    assert.equal((await hit("198.51.100.4")).status, 429, "both count as the same unknown client");
  });

  test("ctx.waitUntil hands work to Vercel's request context", async () => {
    const later: string[] = [];
    const waited: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[VERCEL_CONTEXT] = { get: () => ({ waitUntil: (p: Promise<unknown>) => void waited.push(p) }) };
    const res = await makeApp(later).fetch(new Request("https://notes.vercel.app/background", { method: "POST" }));
    assert.deepEqual(await res.json(), { queued: true });
    assert.equal(waited.length, 1);
    await waited[0];
    assert.deepEqual(later, ["done"]);
  });

  test("without a request context, the app tracks the work and app.close() waits for it", async () => {
    const later: string[] = [];
    const app = makeApp(later);
    const res = await app.fetch(new Request("https://notes.vercel.app/background", { method: "POST" }));
    assert.deepEqual(await res.json(), { queued: true });
    await app.close();
    assert.deepEqual(later, ["done"]);
  });

  test("a streamed AI answer", async () => {
    process.env.VERCEL = "1";
    const res = await makeApp().fetch(new Request("https://notes.vercel.app/chat", { headers: { "x-real-ip": "203.0.113.7" } }));
    const text = await res.text();
    assert.equal([...text.matchAll(/event: text\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]!) as string).join(""), "Streamed answer.");
  });
});
