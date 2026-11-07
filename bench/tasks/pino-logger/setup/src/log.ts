import pino from "pino";

/** Entries written by the shared logger, for the checks. In production the logger writes to stdout. */
export const lines: Record<string, unknown>[] = [];

export const log = pino({ base: { service: "notes" } }, { write: (line: string) => void lines.push(JSON.parse(line)) });
