import { Writable } from "node:stream";
import winston from "winston";

/** Entries written by the shared logger, for the checks. In production the logger writes to stdout. */
export const lines: Record<string, unknown>[] = [];

const capture = new Writable({
  write(chunk, _encoding, done) {
    for (const line of String(chunk).split("\n")) if (line.trim()) lines.push(JSON.parse(line));
    done();
  },
});

export const log = winston.createLogger({
  format: winston.format.json(),
  defaultMeta: { service: "notes" },
  transports: [new winston.transports.Stream({ stream: capture })],
});
