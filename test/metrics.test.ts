import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMetrics } from "../src/metrics.ts";
import { createApp, InferloError, job, mockProvider, route, t, type Usage } from "../src/index.ts";

const quiet = { info: () => {}, error: () => {} };
const TOKEN = "metrics-token-0123456789abcdef";

const getTicket = route.get("/tickets/:id", { auth: "public" }).handle(({ params }) => ({ id: params.id }));
const createTicket = route.post("/tickets", { auth: "public", body: t.object({ title: t.string().max(100) }) }).handle(({ body, status }) => {
  status(201);
  return body;
});
const summarize = route.post("/summarize", { auth: "public" }).handle(async ({ ai }) => {
  const { text } = await ai.generate({ model: "fast", prompt: "Summarize this ticket please" });
  return { text };
});
const slow = route.get("/slow", { auth: "public" }).handle(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 20)));

/** Parses the Prometheus text format into "name{labels}" -> value. */
function parse(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const at = line.lastIndexOf(" ");
    out.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return out;
}

async function scrape(app: { request(path: string, options?: { headers?: Record<string, string> }): Promise<Response> }, token = TOKEN) {
  const res = await app.request("/metrics", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  return { text: await res.text(), res };
}

describe("metrics", () => {
  test("off by default: no /metrics endpoint and describe() says so", async () => {
    const app = createApp({ routes: [{ getTicket }], logger: quiet });
    assert.equal((await app.request("/metrics")).status, 404);
    assert.equal(app.describe().endpoints.metrics, false);
  });

  test("counts requests by method, route pattern and status, with duration histograms", async () => {
    const app = createApp({ name: "helpdesk", version: "1.2.3", routes: [{ getTicket, createTicket, slow }], logger: quiet, metrics: true });
    await app.request("/tickets/1");
    await app.request("/tickets/2");
    await app.request("/tickets", { method: "POST", json: { title: "Printer" } });
    await app.request("/tickets", { method: "POST", json: { title: 42 } });
    await app.request("/nope");
    await app.request("/slow");
    const res = await app.request("/metrics");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    const m = parse(text);
    assert.match(text, /# TYPE inferlo_http_requests_total counter/);
    assert.match(text, /# TYPE inferlo_http_request_duration_seconds histogram/);
    assert.equal(m.get(`inferlo_info{app="helpdesk",version="1.2.3",inferlo="${app.describe().inferlo}"}`), 1);
    // The route pattern, not the path: one series for every ticket id.
    assert.equal(m.get('inferlo_http_requests_total{method="GET",route="/tickets/:id",status="200"}'), 2);
    assert.equal(m.get('inferlo_http_requests_total{method="POST",route="/tickets",status="201"}'), 1);
    assert.equal(m.get('inferlo_http_requests_total{method="POST",route="/tickets",status="422"}'), 1);
    assert.equal(m.get('inferlo_http_requests_total{method="GET",route="unmatched",status="404"}'), 1);
    assert.equal(m.get('inferlo_http_request_duration_seconds_count{method="GET",route="/tickets/:id"}'), 2);
    assert.equal(m.get('inferlo_http_request_duration_seconds_bucket{method="GET",route="/tickets/:id",le="+Inf"}'), 2);
    // The slow route took at least 20 ms: it is not in the 5 ms and 10 ms buckets.
    assert.equal(m.get('inferlo_http_request_duration_seconds_bucket{method="GET",route="/slow",le="0.01"}'), 0);
    assert.equal(m.get('inferlo_http_request_duration_seconds_bucket{method="GET",route="/slow",le="10"}'), 1);
    assert.ok(m.get('inferlo_http_request_duration_seconds_sum{method="GET",route="/slow"}')! >= 0.015);
    // The scrape itself is counted as in flight, but not as a request.
    assert.equal(m.get("inferlo_http_requests_in_flight"), 1);
    assert.ok(![...m.keys()].some((k) => k.includes('route="/metrics"')));
    assert.ok(![...m.keys()].some((k) => k.includes("/tickets/1")));
  });

  test("unknown methods are counted as OTHER, so clients cannot create unlimited series", async () => {
    const app = createApp({ routes: [{ getTicket }], logger: quiet, metrics: true });
    await app.request("/tickets/1", { method: "PROPFIND" as never });
    const m = parse(await (await app.request("/metrics")).text());
    assert.equal(m.get('inferlo_http_requests_total{method="OTHER",route="unmatched",status="405"}'), 1);
  });

  test("health checks, the metrics endpoint and requests answered by middleware", async () => {
    const blocked = async (ctx: { url: URL }, next: () => Promise<Response>) => (ctx.url.pathname === "/blocked" ? new Response("no", { status: 403 }) : next());
    const app = createApp({ routes: [{ getTicket }], logger: quiet, metrics: true, health: true, middleware: [blocked] });
    await app.request("/health");
    await app.request("/ready");
    await app.request("/metrics");
    await app.request("/blocked");
    await app.request("/openapi.json");
    const m = parse(await (await app.request("/metrics")).text());
    const series = [...m.keys()].filter((k) => k.startsWith("inferlo_http_requests_total"));
    assert.deepEqual(series.sort(), ['inferlo_http_requests_total{method="GET",route="/openapi.json",status="200"}', 'inferlo_http_requests_total{method="GET",route="unmatched",status="403"}']);
    assert.equal(app.describe().endpoints.metrics, "/metrics");
  });

  test("a token requires Authorization: Bearer <token>", async () => {
    const app = createApp({ routes: [{ getTicket }], logger: quiet, metrics: { token: TOKEN } });
    const none = await app.request("/metrics");
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="metrics"');
    assert.equal((await none.json()).error.code, "IL3001");
    assert.equal((await app.request("/metrics", { headers: { authorization: `Bearer ${TOKEN}x` } })).status, 401);
    assert.equal((await app.request("/metrics", { headers: { authorization: TOKEN } })).status, 401);
    const { text } = await scrape(app);
    assert.match(text, /inferlo_info/);
    // HEAD works for checks, without a body.
    const head = await app.request("/metrics", { method: "HEAD", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("a custom path and buckets", async () => {
    const app = createApp({ routes: [{ getTicket }], logger: quiet, metrics: { path: "/internal/metrics", buckets: [0.1, 1] } });
    await app.request("/tickets/1");
    assert.equal((await app.request("/metrics")).status, 404);
    const text = await (await app.request("/internal/metrics")).text();
    assert.match(text, /inferlo_http_request_duration_seconds_bucket\{method="GET",route="\/tickets\/:id",le="0.1"\} 1/);
    assert.match(text, /le="1"\} 1/);
    assert.doesNotMatch(text, /le="0.005"/);
    assert.equal(app.describe().endpoints.metrics, "/internal/metrics");
  });

  test("AI calls, tokens, cost and durations per alias, and the app's own onUsage still runs", async () => {
    const seen: Usage[] = [];
    const app = createApp({
      routes: [{ summarize }],
      logger: quiet,
      metrics: true,
      ai: {
        providers: { mock: mockProvider({ respond: () => "Printer is broken" }) },
        models: { fast: "mock:small", embed: "mock:embedder" },
        pricing: { "mock:small": { input: 1_000_000, output: 2_000_000 } },
        onUsage: (usage) => void seen.push(usage),
      },
    });
    await app.request("/summarize", { method: "POST" });
    await app.request("/summarize", { method: "POST" });
    await app.ai.embed({ input: "hello world" });
    await app.ai.stream({ model: "fast", prompt: "hi" }).text();
    assert.equal(seen.length, 4);
    const m = parse(await (await app.request("/metrics")).text());
    assert.equal(m.get('inferlo_ai_calls_total{requested="fast",model="mock:small",kind="generate"}'), 2);
    assert.equal(m.get('inferlo_ai_calls_total{requested="fast",model="mock:small",kind="stream"}'), 1);
    assert.equal(m.get('inferlo_ai_calls_total{requested="embed",model="mock:embedder",kind="embed"}'), 1);
    const generated = seen.filter((u) => u.requested === "fast");
    const input = generated.reduce((sum, u) => sum + u.inputTokens, 0);
    const output = generated.reduce((sum, u) => sum + u.outputTokens, 0);
    assert.equal(m.get('inferlo_ai_tokens_total{requested="fast",model="mock:small",type="input"}'), input);
    assert.equal(m.get('inferlo_ai_tokens_total{requested="fast",model="mock:small",type="output"}'), output);
    assert.equal(m.get('inferlo_ai_cost_usd_total{requested="fast",model="mock:small"}'), input + 2 * output);
    assert.equal(m.get('inferlo_ai_cost_usd_total{requested="embed",model="mock:embedder"}'), 0);
    assert.equal(m.get('inferlo_ai_call_duration_seconds_count{requested="fast",model="mock:small"}'), 3);
  });

  test("job attempts by job and outcome, with durations", async () => {
    let calls = 0;
    const flaky = job("flaky", { input: t.object({}), retries: 1 }).handle(() => {
      if (++calls === 1) throw new Error("first attempt fails");
    });
    const broken = job("broken", { input: t.object({}), retries: 0 }).handle(() => {
      throw new Error("always fails");
    });
    const app = createApp({ jobs: [{ flaky, broken }], logger: quiet, metrics: true });
    await app.jobs.enqueue(flaky, {});
    await app.jobs.enqueue(broken, {});
    await app.jobs.runDue();
    await app.jobs.runDue({ now: new Date(Date.now() + 60_000) });
    const m = parse(await (await app.request("/metrics")).text());
    assert.equal(m.get('inferlo_job_runs_total{job="flaky",outcome="retried"}'), 1);
    assert.equal(m.get('inferlo_job_runs_total{job="flaky",outcome="done"}'), 1);
    assert.equal(m.get('inferlo_job_runs_total{job="broken",outcome="failed"}'), 1);
    assert.equal(m.get('inferlo_job_duration_seconds_count{job="flaky"}'), 2);
  });

  test("label values are escaped", () => {
    const metrics = createMetrics({ app: 'say "hi"\\there\nnow', version: "1", inferlo: "0" }, [1]);
    assert.match(metrics.render(), /app="say \\"hi\\"\\\\there\\nnow"/);
  });

  test("invalid options raise IL6020", () => {
    const bad = (metrics: unknown, routes: unknown[] = [], extra: object = {}) =>
      assert.throws(() => createApp({ routes: routes as never, logger: quiet, metrics: metrics as never, ...extra }), (e: unknown) => e instanceof InferloError && e.code === "IL6020");
    bad("yes");
    bad({ path: "metrics" });
    bad({ token: "short" });
    bad({ token: 123 });
    // An unset variable must not silently make the endpoint public.
    bad({ token: undefined });
    bad({ buckets: [1, 0.5] });
    bad({ buckets: [] });
    bad({ bucket: [1] });
    bad({ path: "/openapi.json" });
    bad({ path: "/health" }, [], { health: true });
    bad(true, [route.get("/metrics", { auth: "public" }).handle(() => ({}))]);
    // A POST route on the same path is fine: the endpoint only answers GET and HEAD.
    createApp({ routes: [route.post("/metrics", { auth: "public" }).handle(() => ({}))], logger: quiet, metrics: true });
  });
});
