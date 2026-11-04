/**
 * Logging: the built-in logger (text or JSON lines), request ids and request logs.
 *
 *   createApp({ logging: { format: "json", requests: true } })
 *
 * prints one JSON object per line, and one line per request with its id, method, path, status and duration.
 */
import { InferloError } from "./errors.ts";

/** Structured fields of a log entry, such as the request id. Values are strings, numbers or booleans. */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface LoggingConfig {
  /** Output of the built-in logger: "text" (default, readable) or "json" (one JSON object per line, for log collectors). */
  format?: "text" | "json";
  /** Log every request with its id, method, path, status and duration in milliseconds. Default false. */
  requests?: boolean;
}

/** Incoming X-Request-Id values that are kept (with trustProxy): 1 to 128 letters, digits and . _ : - characters. */
export const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export interface LoggerShape {
  info(message: string, data?: unknown, fields?: LogFields): void;
  error(message: string, data?: unknown, fields?: LogFields): void;
}

/** Checks createApp({ logging }) and returns it with defaults. */
export function loggingOptions(option: unknown, hasLogger: boolean): { format: "text" | "json"; requests: boolean } {
  if (option === undefined) return { format: "text", requests: false };
  const problems: string[] = [];
  if (!option || typeof option !== "object" || Array.isArray(option)) problems.push("logging must be an object such as { format: \"json\", requests: true }");
  else {
    const { format, requests, ...rest } = option as Record<string, unknown>;
    if (format !== undefined && format !== "text" && format !== "json") problems.push(`format must be "text" or "json", got ${JSON.stringify(format)}`);
    if (format !== undefined && hasLogger) problems.push("format only applies to the built-in logger; your own logger decides how entries are written");
    if (requests !== undefined && typeof requests !== "boolean") problems.push("requests must be true or false");
    for (const key of Object.keys(rest)) problems.push(`unknown option "${key}"`);
  }
  if (problems.length) {
    throw new InferloError("IL6019", `Invalid logging options: ${problems.join("; ")}.`, {
      fix: 'Use createApp({ logging: { format: "json", requests: true } }). With your own logger, leave out format and read the third argument of info and error for fields such as requestId.',
    });
  }
  const { format = "text", requests = false } = option as LoggingConfig;
  return { format, requests };
}

/** The built-in logger: "[inferlo] message" lines, or one JSON object per line. */
export function defaultLogger(format: "text" | "json", app: string): LoggerShape {
  if (format === "text") {
    const line = (message: string, fields?: LogFields) => `[inferlo] ${message}${fields?.requestId ? ` (request ${fields.requestId})` : ""}`;
    return {
      info: (message, data, fields) => console.log(line(message, fields), data ?? ""),
      error: (message, data, fields) => console.error(line(message, fields), data ?? ""),
    };
  }
  const write = (level: "info" | "error", message: string, data: unknown, fields: LogFields | undefined) => {
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level, app, msg: message };
    for (const [key, value] of Object.entries(fields ?? {})) if (value !== undefined && !(key in entry)) entry[key] = value;
    if (data instanceof Error) entry.error = serializeError(data);
    else if (data !== undefined && data !== "") entry.data = data;
    let text: string;
    try {
      text = JSON.stringify(entry);
    } catch {
      text = JSON.stringify({ ...entry, data: String(data) });
    }
    if (level === "error") console.error(text);
    else console.log(text);
  };
  return {
    info: (message, data, fields) => write("info", message, data, fields),
    error: (message, data, fields) => write("error", message, data, fields),
  };
}

/** An error as plain JSON: name, message, code and status when present, stack, and causes. */
export function serializeError(error: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  const extra = error as Error & { code?: unknown; status?: unknown };
  if (typeof extra.code === "string" || typeof extra.code === "number") out.code = extra.code;
  if (typeof extra.status === "number") out.status = extra.status;
  if (error.stack) out.stack = error.stack;
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 5) out.cause = cause instanceof Error ? serializeError(cause, depth + 1) : cause;
  return out;
}
