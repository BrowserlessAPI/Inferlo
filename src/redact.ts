/**
 * Secret redaction for everything createApp logs (and the error messages exposeErrors shows): credentials in
 * headers, tokens, API keys, passwords in URLs, the app's AI provider keys and the values passed to
 * createApp({ redact }). Internal: createApp wraps its logger with redactingLogger().
 */
import { InferloError } from "./errors.ts";

export const REDACTED = "[redacted]";

/** Secret values of objects that hold them (config() results, AI providers), looked up by createApp. */
const heldSecrets = new WeakMap<object, readonly string[]>();

/** Internal: remember the secret values an object holds (a config() result or an AI provider). */
export function holdSecrets<T extends object>(owner: T, values: readonly (string | undefined | null)[]): T {
  const list = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (list.length) heldSecrets.set(owner, [...(heldSecrets.get(owner) ?? []), ...list]);
  return owner;
}

export function secretsOf(owner: unknown): readonly string[] {
  return owner && typeof owner === "object" ? (heldSecrets.get(owner) ?? []) : [];
}

const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|apikey|password|passwd|secret|client[-_]?secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|private[-_]?key|session)$/i;

const PATTERNS: [RegExp, string | ((...groups: string[]) => string)][] = [
  // Header-like "name: value" or "name=value" pairs, also inside JSON text. Cookies run to the end of the value.
  [/\b(cookie|set-cookie)(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^"'\r\n]+/gi, `$1$2${REDACTED}`],
  [
    /\b(authorization|proxy-authorization|x-api-key|api-key)(["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Token)\s+)?(?!\[redacted\]|(?:Bearer|Basic|Token)\s)[^\s"',;]+/gi,
    (_match, name, separator, scheme) => `${name}${separator}${scheme ? `${scheme} ` : ""}${REDACTED}`,
  ],
  // Bearer <token> and Basic <credentials> anywhere else
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/g, `$1 ${REDACTED}`],
  // Passwords in connection strings and URLs: postgres://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi, `$1${REDACTED}@`],
  // Secrets in query strings: ?key=..., &access_token=...
  [/([?&](?:key|api_key|apikey|access_token|token|secret|password|signature|sig)=)[^&\s"'#]+/gi, `$1${REDACTED}`],
  // Well-known API key formats: OpenAI and Anthropic (sk-...), Google (AIza...), GitHub tokens.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
];

export interface Redactor {
  text(value: string): string;
  value(value: unknown): unknown;
}

export function createRedactor(secretValues: readonly string[]): Redactor {
  // Longest first, so a secret that contains another is replaced whole. Very short values would hide normal text.
  const known = [...new Set(secretValues.filter((v) => v.length >= 6))].sort((a, b) => b.length - a.length);

  const text = (input: string): string => {
    let out = input;
    for (const secret of known) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement as string);
    return out;
  };

  const value = (input: unknown, depth = 0, seen = new WeakMap<object, unknown>()): unknown => {
    if (typeof input === "string") return text(input);
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    if (depth > 8) return input;
    if (input instanceof Error) {
      const copy = Object.create(Object.getPrototypeOf(input)) as Error;
      seen.set(input, copy);
      Object.defineProperty(copy, "message", { value: text(input.message), writable: true, configurable: true });
      if (input.stack !== undefined) Object.defineProperty(copy, "stack", { value: text(input.stack), writable: true, configurable: true });
      if (input.name !== Object.getPrototypeOf(input)?.name) Object.defineProperty(copy, "name", { value: input.name, writable: true, configurable: true });
      for (const key of Object.keys(input)) (copy as unknown as Record<string, unknown>)[key] = redactEntry(key, (input as unknown as Record<string, unknown>)[key], depth, seen);
      if ("cause" in input) Object.defineProperty(copy, "cause", { value: value(input.cause, depth + 1, seen), writable: true, configurable: true });
      return copy;
    }
    if (typeof Headers !== "undefined" && input instanceof Headers) {
      const out: Record<string, unknown> = {};
      seen.set(input, out);
      input.forEach((v, k) => (out[k] = redactEntry(k, v, depth, seen)));
      return out;
    }
    if (Array.isArray(input)) {
      const out: unknown[] = [];
      seen.set(input, out);
      for (const item of input) out.push(value(item, depth + 1, seen));
      return out;
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return input;
    const out: Record<string, unknown> = {};
    seen.set(input, out);
    for (const [k, v] of Object.entries(input)) out[k] = redactEntry(k, v, depth, seen);
    return out;
  };

  const redactEntry = (key: string, entry: unknown, depth: number, seen: WeakMap<object, unknown>): unknown => {
    if (SENSITIVE_KEY.test(key) && entry !== undefined && entry !== null && entry !== "") return REDACTED;
    return value(entry, depth + 1, seen);
  };

  return { text, value: (input) => value(input) };
}

export interface LoggerLike {
  info(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** A logger that redacts every message and data value before passing them on. */
export function redactingLogger(logger: LoggerLike, redactor: Redactor): LoggerLike {
  return {
    info: (message, data) => (data === undefined ? logger.info(redactor.text(String(message))) : logger.info(redactor.text(String(message)), redactor.value(data))),
    error: (message, data) => (data === undefined ? logger.error(redactor.text(String(message))) : logger.error(redactor.text(String(message)), redactor.value(data))),
  };
}

/** The values of createApp({ redact }): strings, or objects that hold secrets (config() results). */
export function redactValues(option: unknown): string[] {
  if (option === undefined) return [];
  if (!Array.isArray(option)) throw invalidRedact(`createApp({ redact }) must be an array, got ${typeof option}.`);
  const out: string[] = [];
  option.forEach((item, i) => {
    if (item === undefined || item === null || item === "") return; // an unset optional variable
    if (typeof item === "string") out.push(item);
    else if (typeof item === "object" && configs.has(item)) out.push(...secretsOf(item));
    else throw invalidRedact(`createApp({ redact }) item ${i} is ${typeof item === "object" ? "an object that is not a config() result" : `a ${typeof item}`}.`);
  });
  return out;
}

const configs = new WeakSet<object>();
/** Internal: remember a config() result and its secret values, for createApp({ redact: [settings] }). */
export function holdConfigSecrets<T extends object>(settings: T, values: readonly unknown[]): T {
  configs.add(settings);
  return holdSecrets(settings, values.map((v) => (v === undefined || v === null ? undefined : String(v))));
}

function invalidRedact(message: string): InferloError {
  return new InferloError("IL6018", message, {
    fix: "Pass the values to hide from logs, or your config() result: createApp({ redact: [settings, process.env.WEBHOOK_SECRET] }).",
  });
}
