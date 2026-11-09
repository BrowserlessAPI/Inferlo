/**
 * Winston as the logger of an Inferlo app, without a runtime dependency on winston:
 *
 *   import winston from "winston";
 *   import { createApp } from "@browserlessapi/inferlo";
 *   import { winstonLogger } from "@browserlessapi/inferlo/winston";
 *
 *   const log = winston.createLogger({ format: winston.format.json(), transports: [new winston.transports.Console()] });
 *   const app = createApp({ routes, logger: winstonLogger(log), logging: { requests: true } });
 *
 * Inferlo's request logs, error logs, job logs and readiness logs are written with log.info(message, meta) and
 * log.error(message, meta): fields such as requestId, traceId, spanId, method, path, status and durationMs become
 * top-level properties of the winston entry, an error is written as `error` (plain JSON with its name, message, code,
 * status, stack and cause, so winston's json format does not turn it into {}), and other data goes under `data`.
 * Entries are redacted by Inferlo before they reach winston; winston's level, defaultMeta, formats and transports
 * still apply. The logger that nest-winston provides (WINSTON_MODULE_PROVIDER) is a winston logger too.
 */
import type { Logger } from "./app.ts";
import { InferloError } from "./errors.ts";
import { serializeError, type LogFields } from "./logging.ts";

/** The two methods of a winston logger (winston 3, a child logger, or nest-winston's) that Inferlo calls. */
export interface WinstonLike {
  info(message: string, meta?: object): unknown;
  error(message: string, meta?: object): unknown;
}

const fix = 'Pass a winston logger: import winston from "winston"; createApp({ logger: winstonLogger(winston.createLogger({ transports: [new winston.transports.Console()] })) }). A child logger (log.child({ service })) works too.';

/** Keys winston itself sets on an entry; a field with one of these names would overwrite it. */
const RESERVED = new Set(["level", "message"]);

/** Writes Inferlo's log entries through a winston logger: createApp({ logger: winstonLogger(log) }). */
export function winstonLogger(logger: WinstonLike): Logger {
  const target = logger as unknown as Record<string, unknown> | null | undefined;
  if (!target || typeof target !== "object" || typeof target.info !== "function" || typeof target.error !== "function") {
    throw new InferloError("IL6061", `winstonLogger() needs a winston logger, got ${target === null ? "null" : Array.isArray(target) ? "an array" : typeof target === "object" ? "an object without info and error methods" : typeof target}.`, { fix });
  }
  const meta = (data: unknown, fields: LogFields | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (fields) for (const [key, value] of Object.entries(fields)) if (value !== undefined && !RESERVED.has(key)) out[key] = value;
    if (data instanceof Error) out.error = serializeError(data);
    else if (data !== undefined && data !== "") out.data = data;
    return out;
  };
  return {
    info: (message, data, fields) => void logger.info(message, meta(data, fields)),
    error: (message, data, fields) => void logger.error(message, meta(data, fields)),
  };
}
