/**
 * Guardrails for AI calls: limits and checks on what goes to the model and what comes back, set per alias in
 * createAI({ guardrails }) / createApp({ ai: { guardrails } }) and per call with ai.generate({ guardrails }).
 * Where several apply, the strictest wins: the smallest limits, and every blocked term and kind of personal data.
 */
import { InferloError } from "../errors.ts";
import type { Message } from "./providers.ts";

/** Kinds of personal data guardrails can replace in user messages before they reach the model. */
export type PiiKind = "email" | "phone" | "card" | "iban" | "ip";

export interface Guardrails {
  /** Most characters of user input in one call (all user messages together). Longer input is refused with IL5042. */
  maxInputChars?: number;
  /** Largest maxTokens a call may ask for, and the maxTokens of calls that set none. */
  maxTokens?: number;
  /**
   * Words and phrases refused in user input (IL5042) and in the model's answer (IL5043), matched as whole words,
   * ignoring case and the amount of space between words. Streams hold back the last words until it is clear they
   * are not part of a blocked term.
   */
  blockedTerms?: readonly string[];
  /** Personal data replaced in user messages before they reach the model ("[email]", "[card]", ...). */
  redact?: readonly PiiKind[];
}

const KINDS: readonly PiiKind[] = ["email", "phone", "card", "iban", "ip"];
const KEYS = ["maxInputChars", "maxTokens", "blockedTerms", "redact"];
const DOCS = "See Guardrails in docs/ai.md.";

function invalid(message: string): InferloError {
  return new InferloError("IL5044", message, { fix: DOCS });
}

/** Checks one set of guardrails. Raises IL5044. */
export function checkGuardrails(value: unknown, where: string): Guardrails {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${where} must be an object with maxInputChars, maxTokens, blockedTerms or redact.`);
  const unknown = Object.keys(value).filter((key) => !KEYS.includes(key));
  if (unknown.length) throw invalid(`${where} has unknown option ${unknown.map((k) => `"${k}"`).join(", ")}; use maxInputChars, maxTokens, blockedTerms or redact.`);
  const g = value as Record<string, unknown>;
  for (const key of ["maxInputChars", "maxTokens"]) {
    const n = g[key];
    if (n !== undefined && (!Number.isSafeInteger(n) || (n as number) < 1)) throw invalid(`${where}.${key} must be a whole number of at least 1, got ${JSON.stringify(n)}.`);
  }
  const terms = g.blockedTerms;
  if (terms !== undefined && (!Array.isArray(terms) || terms.some((t) => typeof t !== "string" || !t.trim() || t.length > 200))) {
    throw invalid(`${where}.blockedTerms must be a list of words or phrases (1 to 200 characters each).`);
  }
  const redact = g.redact;
  if (redact !== undefined && (!Array.isArray(redact) || redact.some((k) => !KINDS.includes(k as PiiKind)))) {
    throw invalid(`${where}.redact must list kinds of personal data from ${KINDS.map((k) => `"${k}"`).join(", ")}, got ${JSON.stringify(redact)}.`);
  }
  return g as Guardrails;
}

/** Checks createAI({ guardrails }): keys are configured aliases or "*" (every call). */
export function checkGuardrailsConfig(value: unknown, aliases: readonly string[]): Record<string, Guardrails> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid('guardrails must map aliases (or "*" for every call) to guardrails: { "*": { maxInputChars: 20000 }, support: { blockedTerms: [...] } }.');
  const out: Record<string, Guardrails> = {};
  for (const [key, g] of Object.entries(value)) {
    if (key !== "*" && !aliases.includes(key)) throw invalid(`guardrails names "${key}", which is not a model alias. Use "*" or one of: ${aliases.map((a) => `"${a}"`).join(", ") || "(no aliases)"}.`);
    out[key] = checkGuardrails(g, `guardrails[${JSON.stringify(key)}]`);
  }
  return out;
}

/** The guardrails of one call: "*", the alias's and the call's own, the strictest of each. */
export function mergeGuardrails(list: (Guardrails | undefined)[]): Guardrails | undefined {
  const present = list.filter((g): g is Guardrails => g !== undefined);
  if (!present.length) return undefined;
  const min = (key: "maxInputChars" | "maxTokens") => {
    const values = present.map((g) => g[key]).filter((n): n is number => n !== undefined);
    return values.length ? Math.min(...values) : undefined;
  };
  const terms = [...new Set(present.flatMap((g) => g.blockedTerms ?? []))];
  const redact = [...new Set(present.flatMap((g) => g.redact ?? []))];
  const out: Guardrails = {};
  const maxInputChars = min("maxInputChars");
  const maxTokens = min("maxTokens");
  if (maxInputChars !== undefined) out.maxInputChars = maxInputChars;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  if (terms.length) out.blockedTerms = terms;
  if (redact.length) out.redact = redact;
  return out;
}

/** maxTokens for the call: the call's own (never above the guardrail), or the guardrail's. Raises IL5044. */
export function guardedMaxTokens(requested: number | undefined, g: Guardrails | undefined, kind: "generate" | "stream"): number | undefined {
  if (!g?.maxTokens) return requested;
  if (requested === undefined) return g.maxTokens;
  if (requested > g.maxTokens) {
    throw new InferloError("IL5044", `ai.${kind}({ maxTokens: ${requested} }) is above the guardrail maxTokens of ${g.maxTokens}.`, {
      fix: "Ask for fewer tokens, or raise maxTokens in the guardrails of this alias.",
    });
  }
  return requested;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(iban: string): boolean {
  const s = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of s) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rest = (rest * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rest === 1;
}

const PATTERNS: Record<PiiKind, { pattern: RegExp; keep?: (match: string) => boolean }> = {
  email: { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  iban: { pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, keep: (m) => !ibanValid(m.replace(/ /g, "")) },
  card: { pattern: /\b\d(?:[ -]?\d){12,18}\b/g, keep: (m) => !luhn(m.replace(/[ -]/g, "")) },
  ip: { pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b|\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b/g },
  // International numbers (+ and country code) and North American numbers such as (415) 555-0100.
  phone: {
    pattern: /\+\d[\d ().-]{5,}\d|(?<!\d)\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g,
    keep: (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits < 8 || digits > 15;
    },
  },
};

/** Replaces the chosen kinds of personal data in a text. Emails first, so their digits are not taken for phones. */
export function redactPii(text: string, kinds: readonly PiiKind[]): string {
  let out = text;
  for (const kind of ["email", "iban", "card", "ip", "phone"] as const) {
    if (!kinds.includes(kind)) continue;
    const { pattern, keep } = PATTERNS[kind];
    out = out.replace(pattern, (match) => (keep?.(match) ? match : `[${kind}]`));
  }
  return out;
}

function termPattern(terms: readonly string[]): RegExp {
  const escaped = [...terms].sort((a, b) => b.length - a.length).map((t) => t.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

/** Applies the input guardrails to the messages of a call: redacts user messages in place, then checks them. Raises IL5042. */
export function guardInput(messages: Message[], g: Guardrails | undefined): void {
  if (!g) return;
  let chars = 0;
  const terms = g.blockedTerms?.length ? termPattern(g.blockedTerms) : undefined;
  for (const m of messages) {
    if (m.role !== "user") continue;
    chars += m.content.length;
    if (terms && (terms.lastIndex = 0, terms.test(m.content))) {
      throw new InferloError("IL5042", "The request was refused: it contains a blocked term.", { status: 422, expose: true, fix: "Rephrase the request." });
    }
    if (g.redact?.length) m.content = redactPii(m.content, g.redact);
  }
  if (g.maxInputChars !== undefined && chars > g.maxInputChars) {
    throw new InferloError("IL5042", `The request was refused: the input is longer than ${g.maxInputChars} characters.`, { status: 422, expose: true, fix: "Send a shorter input." });
  }
}

export function withheld(): InferloError {
  return new InferloError("IL5043", "The model's answer was withheld: it contains a blocked term.", {
    status: 502,
    expose: true,
    fix: "Retry, or change the prompt so the model does not produce terms on the guardrail's blockedTerms list.",
  });
}

/** Whether a complete answer contains a blocked term. */
export function answerBlocked(text: string, g: Guardrails | undefined): boolean {
  if (!g?.blockedTerms?.length) return false;
  return termPattern(g.blockedTerms).test(text);
}

/**
 * Checks streamed text against blocked terms. push() returns the text that is safe to send now, holding back the
 * end of the text that could still turn into a blocked term; end() returns the rest. Both raise IL5043.
 */
export function streamGuard(g: Guardrails | undefined): { push(text: string): string; end(): string } {
  if (!g?.blockedTerms?.length) return { push: (text) => text, end: () => "" };
  const pattern = termPattern(g.blockedTerms);
  // A term that is still being written lies within the last `words` runs of non-space characters.
  const words = Math.max(...g.blockedTerms.map((t) => t.trim().split(/\s+/).length));
  let seen = "";
  let sent = 0;
  /** Where the text that could still be part of a blocked term starts. */
  const holdFrom = (): number => {
    const runs = [...seen.matchAll(/\S+/g)];
    const keep = /\s$/.test(seen) ? words - 1 : words;
    if (keep <= 0) return seen.length;
    return runs.length >= keep ? runs[runs.length - keep]!.index! : 0;
  };
  return {
    push(text) {
      seen += text;
      pattern.lastIndex = 0;
      for (const match of seen.matchAll(pattern)) {
        // A match at the very end may still grow into a longer word ("bad" -> "badge"); end() checks it.
        if (match.index! + match[0].length < seen.length) throw withheld();
      }
      const safe = Math.max(sent, holdFrom());
      const out = seen.slice(sent, safe);
      sent = safe;
      return out;
    },
    end() {
      pattern.lastIndex = 0;
      if (pattern.test(seen)) throw withheld();
      const out = seen.slice(sent);
      seen = "";
      sent = 0;
      return out;
    },
  };
}
