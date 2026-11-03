/**
 * Cron: run a job on a schedule. cron("0 * * * *", hourlyReport) enqueues hourlyReport at the start
 * of every hour (UTC) while a worker runs (app.jobs.start() or inferlo worker).
 *
 * A cron schedules a job, so retries, logging and the job queue work the same way. Each tick gets a
 * fixed job id, so with the database queue every instance can run the schedule and the job is
 * still queued once per tick.
 */
import { InferloError } from "./errors.ts";
import type { JobDef } from "./jobs.ts";

export interface CronDef<J extends JobDef = JobDef> {
  readonly kind: "inferlo.cron";
  /** The five-field schedule: minute hour day-of-month month day-of-week, in UTC. */
  readonly schedule: string;
  /** The job queued at every tick, with input {}. */
  readonly job: J;
  /** The first tick strictly after the given time. */
  next(after: Date): Date;
}

interface Field {
  min: number;
  max: number;
  names?: readonly string[];
}

const FIELDS: readonly Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
];
const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"];

const FIX = 'Use five fields "minute hour day-of-month month day-of-week" in UTC, for example "0 * * * *" (every hour), "*/15 * * * *" (every 15 minutes) or "30 3 * * 1-5" (03:30 on weekdays).';

function invalid(schedule: unknown, problem: string): InferloError {
  return new InferloError("IL6013", `Invalid cron schedule ${JSON.stringify(schedule)}: ${problem}.`, { fix: FIX });
}

function parseValue(text: string, field: Field, schedule: string, name: string): number {
  const lower = text.toLowerCase();
  const named = field.names?.indexOf(lower) ?? -1;
  if (named !== -1) return named + field.min;
  if (!/^\d+$/.test(text)) throw invalid(schedule, `"${text}" is not a valid ${name}`);
  const n = Number(text);
  if (n < field.min || n > field.max) throw invalid(schedule, `${name} ${n} is outside ${field.min}-${field.max}`);
  return n;
}

/** The allowed values of one field, and whether it was "*" (no restriction). */
function parseField(text: string, field: Field, schedule: string, name: string): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || range === undefined || range === "") throw invalid(schedule, `"${part}" is not a valid ${name}`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw invalid(schedule, `step "${stepText}" in the ${name} must be a whole number of at least 1`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || !a || !b) throw invalid(schedule, `"${range}" is not a valid ${name} range`);
      from = parseValue(a, field, schedule, name);
      to = parseValue(b, field, schedule, name);
      if (from > to) throw invalid(schedule, `the ${name} range "${range}" goes backwards`);
    } else {
      from = parseValue(range, field, schedule, name);
      to = stepText === undefined ? from : field.max;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any: text === "*" };
}

/** Parse a schedule into a function giving the first tick strictly after a time. Raises IL6013. */
export function parseCron(schedule: string): (after: Date) => Date {
  if (typeof schedule !== "string") throw invalid(schedule, "it must be a string");
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) throw invalid(schedule, `it has ${parts.length} field(s), not 5`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!, schedule, FIELD_NAMES[i]!));
  if (dow!.values.has(7)) dow!.values.add(0); // 7 is Sunday too
  const dayMatches = (d: Date): boolean => {
    const domOk = dom!.values.has(d.getUTCDate());
    const dowOk = dow!.values.has(d.getUTCDay());
    // Standard cron: when both day fields are restricted, either one matching is enough.
    if (!dom!.any && !dow!.any) return domOk || dowOk;
    return domOk && dowOk;
  };
  return (after) => {
    const t = new Date(after.getTime());
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(t.getUTCMinutes() + 1);
    // Enough steps to reach any valid tick (February 29 comes every four years, or eight around 2100).
    for (let guard = 0; guard < 366 * 5 * 24 * 2; guard++) {
      if (!month!.values.has(t.getUTCMonth() + 1)) {
        t.setUTCMonth(t.getUTCMonth() + 1, 1);
        t.setUTCHours(0, 0, 0, 0);
      } else if (!dayMatches(t)) {
        t.setUTCDate(t.getUTCDate() + 1);
        t.setUTCHours(0, 0, 0, 0);
      } else if (!hour!.values.has(t.getUTCHours())) {
        t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      } else if (!minute!.values.has(t.getUTCMinutes())) {
        t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      } else return t;
    }
    throw invalid(schedule, "it never matches a date");
  };
}

/** Run a job on a schedule: export const hourly = cron("0 * * * *", sendReport). Times are UTC. */
export function cron<J extends JobDef>(schedule: string, job: J): CronDef<J> {
  const next = parseCron(schedule);
  if (!job || (job as JobDef).kind !== "inferlo.job") {
    throw new InferloError("IL6013", `cron(${JSON.stringify(schedule)}, ...) needs a job as its second argument.`, {
      fix: 'Pass a job: cron("0 * * * *", job("hourly-report", { input: t.object({}) }).handle(async ({ db }) => { ... })).',
    });
  }
  if (!job.options.input.safeParse({}).ok) {
    throw new InferloError("IL6013", `The job "${job.name}" is run by cron with the input {}, but its input schema does not accept {}.`, {
      fix: "Give jobs run by cron the input t.object({}) (or fields with defaults), and read what they need from the database.",
    });
  }
  next(new Date(0)); // a schedule that never matches (such as "0 0 31 2 *") fails here, not in the worker
  return { kind: "inferlo.cron", schedule: schedule.trim().split(/\s+/).join(" "), job, next };
}

export function isCron(value: unknown): value is CronDef {
  return typeof value === "object" && value !== null && (value as CronDef).kind === "inferlo.cron";
}

/** A fixed UUID for one tick of a cron, so every instance queues the same job id. */
export async function cronTickId(def: CronDef, tick: Date): Promise<string> {
  const data = new TextEncoder().encode(`inferlo.cron:${def.job.name}:${def.schedule}:${tick.toISOString()}`);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8 (custom)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
