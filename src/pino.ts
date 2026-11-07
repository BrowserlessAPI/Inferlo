/**
 * Pino as the logger of an Inferlo app, without a runtime dependency on pino:
 *
 *   import pino from "pino";
 *   import { createApp } from "@browserlessapi/inferlo";
 *   import { pinoLogger } from "@browserlessapi/inferlo/pino";
 *
 *   const log = pino();
 *   const app = createApp({ routes, logger: pinoLogger(log), logging: { requests: true } });
 *
 * Inferlo's request logs, error logs, job logs and readiness logs are written with log.info(fields, message) and
 * log.error(fields, message): fields such as requestId, traceId, spanId, method, path, status and durationMs become
 * top-level properties of the pino entry, an error is passed as `err` (pino's error serializer writes its type,
 * message and stack), and other data goes under `data`. Entries are redacted by Inferlo before they reach pino, and
 * pino's own `redact` option still applies. Fastify's `fastify.log` is a pino logger too.
 */
import type { Logger } from "./app.ts";
import { InferloError } from "./errors.ts";
import type { LogFields } from "./logging.ts";

/** The two methods of a pino logger (pino 9 and later, or fastify.log) that Inferlo calls. */
export interface PinoLike {
  info(object: object, message?: string): void;
  error(object: object, message?: string): void;
}

const fix = 'Pass a pino logger: import pino from "pino"; createApp({ logger: pinoLogger(pino()) }). In Fastify, pinoLogger(fastify.log) writes to Fastify\'s logger.';

/** Writes Inferlo's log entries through a pino logger: createApp({ logger: pinoLogger(pino()) }). */
export function pinoLogger(logger: PinoLike): Logger {
  const target = logger as unknown as Record<string, unknown> | null | undefined;
  if (!target || typeof target !== "object" || typeof target.info !== "function" || typeof target.error !== "function") {
    throw new InferloError("IL6052", `pinoLogger() needs a pino logger, got ${target === null ? "null" : Array.isArray(target) ? "an array" : typeof target === "object" ? "an object without info and error methods" : typeof target}.`, { fix });
  }
  const entry = (data: unknown, fields: LogFields | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (fields) for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
    if (data instanceof Error) out.err = data;
    else if (data !== undefined && data !== "") out.data = data;
    return out;
  };
  return {
    info: (message, data, fields) => logger.info(entry(data, fields), message),
    error: (message, data, fields) => logger.error(entry(data, fields), message),
  };
}
