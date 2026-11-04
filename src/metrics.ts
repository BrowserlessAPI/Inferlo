/**
 * Metrics: request, job and AI counters and histograms in the Prometheus text format.
 *
 *   createApp({ metrics: { token: settings.METRICS_TOKEN } })
 *
 * serves GET /metrics for Prometheus, Grafana Agent, the OpenTelemetry Collector, Datadog and others.
 */
import { InferloError } from "./errors.ts";

export interface MetricsConfig {
  /** Path of the metrics endpoint. Default "/metrics". */
  path?: string;
  /**
   * Require Authorization: Bearer <token> to read metrics (set the same token in the scraper's
   * bearer_token). Without it the endpoint is public, so only leave it out when the endpoint is not
   * reachable from the internet.
   */
  token?: string;
  /** Upper bounds in seconds of the duration histogram buckets. Default 0.005 to 10 seconds. */
  buckets?: readonly number[];
}

export interface ResolvedMetrics {
  path: string;
  token: string | undefined;
  buckets: number[];
}

/** Default histogram buckets in seconds, the same as the Prometheus client libraries. */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Methods outside this list are counted as "OTHER", so clients cannot create unlimited series. */
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Checks createApp({ metrics }) and returns it with defaults, or undefined when metrics are off. */
export function resolveMetrics(option: unknown, taken: { path: string | false; what: string }[]): ResolvedMetrics | undefined {
  if (option === undefined || option === false) return undefined;
  const problems: string[] = [];
  let path = "/metrics";
  let token: string | undefined;
  let buckets = DEFAULT_BUCKETS;
  if (option !== true) {
    if (!option || typeof option !== "object" || Array.isArray(option)) problems.push("metrics must be true or an object such as { token: settings.METRICS_TOKEN }");
    else {
      const { path: p, token: tk, buckets: b, ...rest } = option as Record<string, unknown>;
      if (p !== undefined) {
        if (typeof p !== "string" || !p.startsWith("/")) problems.push(`path must start with "/", got ${JSON.stringify(p)}`);
        else path = p;
      }
      // { token: settings.METRICS_TOKEN } with the variable unset must not make the endpoint public.
      if (tk === undefined && "token" in (option as object)) problems.push("token is undefined (is the variable it comes from set?); leave token out only for a public endpoint");
      else if (tk !== undefined) {
        if (typeof tk !== "string" || tk.length < 16) problems.push("token must be a string of at least 16 characters (a random secret from configuration)");
        else token = tk;
      }
      if (b !== undefined) {
        const ok = Array.isArray(b) && b.length > 0 && b.every((n, i) => typeof n === "number" && Number.isFinite(n) && n > 0 && (i === 0 || n > (b[i - 1] as number)));
        if (!ok) problems.push("buckets must be increasing positive numbers of seconds, such as [0.1, 0.5, 1, 5]");
        else buckets = [...(b as number[])];
      }
      for (const key of Object.keys(rest)) problems.push(`unknown option "${key}"`);
    }
  }
  for (const { path: other, what } of taken) if (!problems.length && other && other.replace(/\/+$/, "") === path.replace(/\/+$/, "")) problems.push(`path ${path} is also ${what}`);
  if (problems.length) {
    throw new InferloError("IL6020", `Invalid metrics options: ${problems.join("; ")}.`, {
      fix: 'Use createApp({ metrics: true }) or createApp({ metrics: { path: "/metrics", token: settings.METRICS_TOKEN } }).',
    });
  }
  return { path, token, buckets };
}

/** True when the request carries Authorization: Bearer <token>, compared in constant time. */
export function hasMetricsToken(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const a = new TextEncoder().encode(match[1]);
  const b = new TextEncoder().encode(token);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]!;
  return diff === 0;
}

type Labels = Record<string, string>;

interface Histogram {
  labels: Labels;
  counts: number[];
  sum: number;
  count: number;
}

function key(labels: Labels): string {
  return JSON.stringify(Object.entries(labels));
}

function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelText(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

function number(n: number): string {
  if (n === Infinity) return "+Inf";
  return String(Math.round(n * 1e9) / 1e9);
}

export interface AppMetrics {
  /** A request finished: route is the route pattern ("/tickets/:id"), or "unmatched". */
  request(method: string, route: string, status: number, seconds: number): void;
  inFlight(delta: number): void;
  job(name: string, outcome: "done" | "retried" | "failed", seconds: number): void;
  ai(usage: { requested: string; model: string; kind: string; inputTokens: number; outputTokens: number; cost: number; durationMs: number }): void;
  /** The Prometheus text exposition of every metric. */
  render(): string;
}

export function createMetrics(info: { app: string; version: string; inferlo: string }, buckets: readonly number[]): AppMetrics {
  const counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  const histograms = new Map<string, Map<string, Histogram>>();
  let inFlight = 0;

  const add = (name: string, labels: Labels, value: number) => {
    let series = counters.get(name);
    if (!series) counters.set(name, (series = new Map()));
    const k = key(labels);
    const entry = series.get(k);
    if (entry) entry.value += value;
    else series.set(k, { labels, value });
  };
  const observe = (name: string, labels: Labels, value: number) => {
    let series = histograms.get(name);
    if (!series) histograms.set(name, (series = new Map()));
    const k = key(labels);
    let h = series.get(k);
    if (!h) series.set(k, (h = { labels, counts: buckets.map(() => 0), sum: 0, count: 0 }));
    for (let i = 0; i < buckets.length; i++) if (value <= buckets[i]!) h.counts[i]!++;
    h.sum += value;
    h.count++;
  };

  const help: Record<string, [type: "counter" | "histogram" | "gauge", help: string]> = {
    inferlo_info: ["gauge", "The app's name and version and the Inferlo version (always 1)."],
    inferlo_http_requests_total: ["counter", "HTTP requests by method, route pattern and status."],
    inferlo_http_request_duration_seconds: ["histogram", "Time until the response headers were ready, by method and route pattern."],
    inferlo_http_requests_in_flight: ["gauge", "HTTP requests being handled now."],
    inferlo_job_runs_total: ["counter", "Job attempts run in this process, by job and outcome (done, retried or failed)."],
    inferlo_job_duration_seconds: ["histogram", "Time each job attempt took, by job."],
    inferlo_ai_calls_total: ["counter", "AI calls by requested alias or model, the model that answered, and kind (generate, stream or embed)."],
    inferlo_ai_tokens_total: ["counter", "AI tokens by requested alias or model, the model that answered, and type (input or output)."],
    inferlo_ai_cost_usd_total: ["counter", "AI cost in US dollars from ai.pricing, by requested alias or model and the model that answered."],
    inferlo_ai_call_duration_seconds: ["histogram", "Time each AI call took, by requested alias or model and the model that answered."],
  };

  return {
    request(method, route, status, seconds) {
      const m = method.toUpperCase();
      const labels = { method: METHODS.has(m) ? m : "OTHER", route };
      add("inferlo_http_requests_total", { ...labels, status: String(status) }, 1);
      observe("inferlo_http_request_duration_seconds", labels, seconds);
    },
    inFlight(delta) {
      inFlight += delta;
    },
    job(name, outcome, seconds) {
      add("inferlo_job_runs_total", { job: name, outcome }, 1);
      observe("inferlo_job_duration_seconds", { job: name }, seconds);
    },
    ai(usage) {
      const labels = { requested: usage.requested, model: usage.model };
      add("inferlo_ai_calls_total", { ...labels, kind: usage.kind }, 1);
      add("inferlo_ai_tokens_total", { ...labels, type: "input" }, usage.inputTokens);
      add("inferlo_ai_tokens_total", { ...labels, type: "output" }, usage.outputTokens);
      add("inferlo_ai_cost_usd_total", labels, usage.cost);
      observe("inferlo_ai_call_duration_seconds", labels, usage.durationMs / 1000);
    },
    render() {
      const lines: string[] = [];
      const header = (name: string) => {
        const [type, text] = help[name]!;
        lines.push(`# HELP ${name} ${text}`, `# TYPE ${name} ${type}`);
      };
      header("inferlo_info");
      lines.push(`inferlo_info${labelText(info)} 1`);
      header("inferlo_http_requests_in_flight");
      lines.push(`inferlo_http_requests_in_flight ${inFlight}`);
      for (const name of Object.keys(help)) {
        const series = counters.get(name);
        if (series) {
          header(name);
          for (const { labels, value } of series.values()) lines.push(`${name}${labelText(labels)} ${number(value)}`);
        }
        const hist = histograms.get(name);
        if (hist) {
          header(name);
          for (const h of hist.values()) {
            buckets.forEach((le, i) => lines.push(`${name}_bucket${labelText({ ...h.labels, le: number(le) })} ${h.counts[i]}`));
            lines.push(`${name}_bucket${labelText({ ...h.labels, le: "+Inf" })} ${h.count}`);
            lines.push(`${name}_sum${labelText(h.labels)} ${number(h.sum)}`, `${name}_count${labelText(h.labels)} ${h.count}`);
          }
        }
      }
      return lines.join("\n") + "\n";
    },
  };
}
