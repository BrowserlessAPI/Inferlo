/**
 * Every error Kairo raises has a stable code, a plain cause, a suggested fix and a docs link.
 * Error codes never change meaning once released, so AI models and humans can rely on them.
 */

export const DOCS_BASE = "https://github.com/BrowserlessAPI/kairo/blob/main/docs/errors.md";

export function docsUrl(code: string): string {
  return `${DOCS_BASE}#${code.toLowerCase()}`;
}

export interface KairoErrorOptions {
  status?: number;
  fix?: string;
  details?: unknown;
  cause?: unknown;
  /** Set to false to hide the message from API clients (it is still logged). */
  expose?: boolean;
}

export class KairoError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fix: string | undefined;
  readonly details: unknown;
  readonly expose: boolean;

  constructor(code: string, message: string, options: KairoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = `KairoError[${code}]`;
    this.code = code;
    this.status = options.status ?? 500;
    this.fix = options.fix;
    this.details = options.details;
    this.expose = options.expose ?? this.status < 500;
  }

  get docs(): string {
    return docsUrl(this.code);
  }

  toJSON() {
    const error: Record<string, unknown> = { code: this.code, message: this.expose ? this.message : "Internal server error" };
    if (this.expose && this.fix) error.fix = this.fix;
    if (this.expose && this.details !== undefined) error.details = this.details;
    error.docs = this.docs;
    return { error };
  }

  /** Multi-line text for terminals and logs. */
  format(): string {
    const lines = [`${this.code}  ${this.message}`];
    if (this.fix) lines.push(`Fix:    ${this.fix}`);
    lines.push(`Docs:   ${this.docs}`);
    return lines.join("\n");
  }
}

/** Throw from a handler to return an HTTP error with your own code and message. */
export function httpError(status: number, message: string, options: { code?: string; fix?: string; details?: unknown } = {}): KairoError {
  return new KairoError(options.code ?? `HTTP${status}`, message, { status, fix: options.fix, details: options.details, expose: true });
}

export function notFound(message = "Not found", details?: unknown): KairoError {
  return new KairoError("KR4001", message, { status: 404, details });
}

export function forbidden(message = "You do not have permission to do this."): KairoError {
  return new KairoError("KR3002", message, { status: 403 });
}

export function badRequest(message: string, details?: unknown): KairoError {
  return new KairoError("HTTP400", message, { status: 400, details });
}

/** Closest candidate by edit distance, used for "did you mean" hints. */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  const lower = input.toLowerCase();
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    let score = distance(lower, c);
    if (c.startsWith(lower) || lower.startsWith(c)) score = Math.min(score, 1);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const limit = Math.max(2, Math.floor(input.length / 3));
  return bestScore <= limit ? best : undefined;
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      prev[j] = Math.min(above + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return prev[b.length]!;
}

export function didYouMean(input: string, candidates: Iterable<string>): string {
  const match = suggest(input, candidates);
  return match ? ` Did you mean "${match}"?` : "";
}
