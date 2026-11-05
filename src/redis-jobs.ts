/**
 * The Redis job queue: createApp({ redis, jobQueue: { store: "redis" } }).
 *
 * Keys (prefix "inferlo:<app name>:"):
 *   jobs:job:<id>     a hash with the job record
 *   jobs:due:<name>   a sorted set of the pending jobs of one job name, scored by runAt (ms)
 *   jobs:running      a sorted set of running jobs, scored by the last report from their worker (Redis clock, ms)
 *
 * Every change is one Lua script, so a job is claimed by one worker only. Times that decide whether a running
 * job is stuck come from the Redis server clock (TIME), so instances with different clocks agree.
 */
import { STALE_AFTER_MS, STOPPED_MESSAGE, type JobRecord, type JobStatus, type JobStore } from "./jobs.ts";
import type { RedisClient } from "./redis.ts";

/** Finished (done or failed) jobs are kept this long, then Redis removes them. */
export const REDIS_FINISHED_TTL_MS = 7 * 24 * 60 * 60_000;

const CLOCK = `local t = redis.call("TIME")
local clock = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

// KEYS[1] job hash, KEYS[2] due set of its name. ARGV[1] id, ARGV[2] runAt ms, ARGV[3] status, ARGV[4..] field pairs.
// A record whose id is already stored is ignored (cron ticks use fixed ids).
const ADD = `if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
redis.call("HSET", KEYS[1], unpack(ARGV, 4))
if ARGV[3] == "pending" then redis.call("ZADD", KEYS[2], ARGV[2], ARGV[1]) end
return 1`;

// KEYS[1] running set, KEYS[2..] due sets (one per name in ARGV[7..], same order).
// ARGV[1] now ms (runAt cutoff), ARGV[2] limit, ARGV[3] staleAfterMs, ARGV[4] stopped message,
// ARGV[5] job hash key prefix, ARGV[6] finished ttl ms.
const CLAIM = `${CLOCK}
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local dueKey = {}
for i = 7, #ARGV do dueKey[ARGV[i]] = KEYS[i - 5] end
local candidates = {}
-- Jobs whose worker stopped reporting: run again, or fail them when no attempts are left.
local stale = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", clock - tonumber(ARGV[3]), "LIMIT", 0, 1000)
for _, id in ipairs(stale) do
  local key = ARGV[5] .. id
  local h = redis.call("HMGET", key, "name", "attempts", "max_attempts", "run_at", "created_at", "status")
  if not h[1] or h[6] ~= "running" then
    redis.call("ZREM", KEYS[1], id)
  elseif dueKey[h[1]] then
    if tonumber(h[2]) >= tonumber(h[3]) then
      redis.call("HSET", key, "status", "failed", "last_error", ARGV[4], "updated_at", clock)
      redis.call("ZREM", KEYS[1], id)
      redis.call("PEXPIRE", key, ARGV[6])
    else
      table.insert(candidates, { id, tonumber(h[4]), tonumber(h[5]), true, h[1] })
    end
  end
end
for i = 7, #ARGV do
  local ids = redis.call("ZRANGEBYSCORE", KEYS[i - 5], "-inf", now, "WITHSCORES", "LIMIT", 0, limit)
  for j = 1, #ids, 2 do
    local created = redis.call("HGET", ARGV[5] .. ids[j], "created_at")
    if created then
      table.insert(candidates, { ids[j], tonumber(ids[j + 1]), tonumber(created), false, ARGV[i] })
    else
      redis.call("ZREM", KEYS[i - 5], ids[j])
    end
  end
end
table.sort(candidates, function(a, b)
  if a[2] ~= b[2] then return a[2] < b[2] end
  if a[3] ~= b[3] then return a[3] < b[3] end
  return a[1] < b[1]
end)
local out = {}
for i = 1, math.min(limit, #candidates) do
  local c = candidates[i]
  local key = ARGV[5] .. c[1]
  if c[4] then redis.call("HSET", key, "last_error", ARGV[4]) end
  redis.call("ZREM", dueKey[c[5]], c[1])
  redis.call("HSET", key, "status", "running", "updated_at", clock)
  redis.call("HINCRBY", key, "attempts", 1)
  redis.call("PERSIST", key)
  redis.call("ZADD", KEYS[1], clock, c[1])
  table.insert(out, redis.call("HGETALL", key))
end
return out`;

// KEYS[1] job hash, KEYS[2] running set. ARGV[1] id, ARGV[2] due key prefix, ARGV[3] finished ttl ms, ARGV[4..] field pairs.
const UPDATE = `${CLOCK}
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
if #ARGV >= 4 then redis.call("HSET", KEYS[1], unpack(ARGV, 4)) end
redis.call("HSET", KEYS[1], "updated_at", clock)
local h = redis.call("HMGET", KEYS[1], "status", "run_at", "name")
local due = ARGV[2] .. h[3]
if h[1] == "pending" then
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZADD", due, h[2], ARGV[1])
  redis.call("PERSIST", KEYS[1])
elseif h[1] == "running" then
  redis.call("ZREM", due, ARGV[1])
  redis.call("ZADD", KEYS[2], clock, ARGV[1])
else
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZREM", due, ARGV[1])
  redis.call("PEXPIRE", KEYS[1], ARGV[3])
end
return 1`;

// KEYS[1] job hash, KEYS[2] running set. ARGV[1] id.
const TOUCH = `${CLOCK}
if redis.call("HGET", KEYS[1], "status") ~= "running" then return 0 end
redis.call("HSET", KEYS[1], "updated_at", clock)
redis.call("ZADD", KEYS[2], "XX", clock, ARGV[1])
return 1`;

/** HGETALL answers: a flat [field, value, ...] list (RESP2), or a Map or object (RESP3). */
function fields(reply: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = String(reply[i + 1]);
  } else if (reply instanceof Map) {
    for (const [k, v] of reply) out[String(k)] = String(v);
  } else if (reply && typeof reply === "object") {
    for (const [k, v] of Object.entries(reply)) out[k] = String(v);
  }
  return out;
}

function fromHash(id: string, h: Record<string, string>): JobRecord {
  const record: JobRecord = {
    id,
    name: h.name!,
    input: JSON.parse(h.input ?? "null") as unknown,
    status: h.status as JobStatus,
    attempts: Number(h.attempts),
    maxAttempts: Number(h.max_attempts),
    runAt: new Date(Number(h.run_at)),
    createdAt: new Date(Number(h.created_at)),
    updatedAt: new Date(Number(h.updated_at)),
  };
  if (h.last_error !== undefined) record.lastError = h.last_error;
  if (h.traceparent !== undefined) {
    record.trace = { traceparent: h.traceparent };
    if (h.tracestate !== undefined) record.trace.tracestate = h.tracestate;
  }
  return record;
}

/**
 * Jobs in Redis, shared by every instance, with the guarantees of the database queue: each due job is claimed by
 * one worker (one atomic script), failed attempts are retried with backoff, a running job whose worker stopped
 * reporting for staleAfterMs is claimed again (or failed without attempts left), and cron ticks are queued once.
 */
export function redisJobStore(client: RedisClient, prefix: string, options: { staleAfterMs?: number; finishedTtlMs?: number } = {}): JobStore {
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const finishedTtlMs = options.finishedTtlMs ?? REDIS_FINISHED_TTL_MS;
  const jobPrefix = `${prefix}jobs:job:`;
  const duePrefix = `${prefix}jobs:due:`;
  const running = `${prefix}jobs:running`;
  return {
    async add(r) {
      const pairs = [
        "id", r.id, "name", r.name, "input", JSON.stringify(r.input ?? null), "status", r.status, "attempts", String(r.attempts),
        "max_attempts", String(r.maxAttempts), "run_at", String(r.runAt.getTime()), "created_at", String(r.createdAt.getTime()),
        "updated_at", String(r.updatedAt.getTime()),
      ];
      if (r.lastError !== undefined) pairs.push("last_error", r.lastError);
      if (r.trace?.traceparent) pairs.push("traceparent", r.trace.traceparent);
      if (r.trace?.tracestate) pairs.push("tracestate", r.trace.tracestate);
      await client.sendCommand(["EVAL", ADD, "2", jobPrefix + r.id, duePrefix + r.name, r.id, String(r.runAt.getTime()), r.status, ...pairs]);
    },
    async claim(now, limit, names) {
      if (!names.length || limit < 1) return [];
      const reply = (await client.sendCommand([
        "EVAL", CLAIM, String(names.length + 1), running, ...names.map((n) => duePrefix + n),
        String(now.getTime()), String(limit), String(staleAfterMs), STOPPED_MESSAGE, jobPrefix, String(finishedTtlMs), ...names,
      ])) as unknown[];
      return reply.map((raw) => {
        const h = fields(raw);
        return fromHash(h.id ?? "", h);
      });
    },
    async update(id, patch) {
      const pairs: string[] = [];
      if (patch.status !== undefined) pairs.push("status", patch.status);
      if (patch.runAt !== undefined) pairs.push("run_at", String(patch.runAt.getTime()));
      if (patch.lastError !== undefined) pairs.push("last_error", patch.lastError);
      await client.sendCommand(["EVAL", UPDATE, "2", jobPrefix + id, running, id, duePrefix, String(finishedTtlMs), ...pairs]);
    },
    async get(id) {
      const h = fields(await client.sendCommand(["HGETALL", jobPrefix + id]));
      return h.name === undefined ? null : fromHash(id, h);
    },
    async touch(id) {
      await client.sendCommand(["EVAL", TOUCH, "2", jobPrefix + id, running, id]);
    },
  };
}
