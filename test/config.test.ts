import assert from "node:assert/strict";
import { inspect } from "node:util";
import { afterEach, describe, test } from "node:test";
import { config, InferloError, setEnv, t } from "../src/index.ts";

const schema = t.object({
  DATABASE_URL: t.string(),
  PORT: t.int().min(1).max(65535).default(3000),
  DEBUG: t.boolean().default(false),
  LOG_LEVEL: t.enum(["debug", "info", "warn", "error"]).default("info"),
  ANTHROPIC_API_KEY: t.string().min(10),
  ALLOWED_ORIGINS: t.array(t.string()).default(() => []),
  SENTRY_DSN: t.string().optional(),
});

// Only these variables are visible to config() (process.env and NODE_ENV from the test runner are hidden).
const blank = Object.fromEntries([...Object.keys(schema.shape), "NAME", "NODE_ENV", "INFERLO_ENV"].map((k) => [k, undefined]));
const only = (vars: Record<string, string>): void => setEnv({ ...blank, ...vars });

function thrown(fn: () => unknown): InferloError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof InferloError, `expected InferloError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected an error");
}

describe("config", () => {
  afterEach(() => setEnv(undefined));

  test("reads, coerces and types values from the environment", () => {
    only({ DATABASE_URL: "postgres://u:p@db/app", PORT: "8080", DEBUG: "true", ANTHROPIC_API_KEY: "sk-ant-1234567890", ALLOWED_ORIGINS: "https://a.io,https://b.io" });
    const settings = config({ schema, secrets: ["DATABASE_URL", "ANTHROPIC_API_KEY"] });
    const port: number = settings.PORT;
    const level: "debug" | "info" | "warn" | "error" = settings.LOG_LEVEL;
    const dsn: string | undefined = settings.SENTRY_DSN;
    assert.equal(port, 8080);
    assert.equal(settings.DEBUG, true);
    assert.equal(level, "info");
    assert.equal(dsn, undefined);
    assert.equal(settings.DATABASE_URL, "postgres://u:p@db/app");
    assert.deepEqual(settings.ALLOWED_ORIGINS, ["https://a.io", "https://b.io"]);
    assert.ok(Object.isFrozen(settings));
    assert.throws(() => {
      (settings as { PORT: number }).PORT = 1;
    }, TypeError);
  });

  test("empty variables count as not set", () => {
    only({ DATABASE_URL: "x", ANTHROPIC_API_KEY: "sk-ant-1234567890", PORT: "" });
    assert.equal(config({ schema }).PORT, 3000);
  });

  test("secrets are redacted in JSON, console.log and String()", () => {
    only({ DATABASE_URL: "postgres://u:hunter2@db/app", ANTHROPIC_API_KEY: "sk-ant-supersecret" });
    const settings = config({ schema, secrets: ["DATABASE_URL", "ANTHROPIC_API_KEY"] });
    const json = JSON.stringify(settings);
    assert.doesNotMatch(json, /hunter2|supersecret/);
    assert.deepEqual(JSON.parse(json), {
      DATABASE_URL: "[redacted]",
      PORT: 3000,
      DEBUG: false,
      LOG_LEVEL: "info",
      ANTHROPIC_API_KEY: "[redacted]",
      ALLOWED_ORIGINS: [],
    });
    assert.doesNotMatch(inspect(settings), /hunter2|supersecret/);
    assert.match(inspect(settings), /\[redacted\]/);
    assert.doesNotMatch(String(settings), /hunter2|supersecret/);
    assert.doesNotMatch(JSON.stringify({ settings }), /hunter2/);
    // The values themselves are still there for the code that needs them.
    assert.equal(settings.ANTHROPIC_API_KEY, "sk-ant-supersecret");
    assert.deepEqual(Object.keys(settings).sort(), ["ALLOWED_ORIGINS", "ANTHROPIC_API_KEY", "DATABASE_URL", "DEBUG", "LOG_LEVEL", "PORT"]);
  });

  test("invalid or missing values raise IL7003 listing every problem, without secret values", () => {
    only({ PORT: "eighty", LOG_LEVEL: "verbose", ANTHROPIC_API_KEY: "tiny9" });
    const error = thrown(() => config({ schema, secrets: ["ANTHROPIC_API_KEY"] }));
    assert.equal(error.code, "IL7003");
    assert.match(error.message, /DATABASE_URL: Required/);
    assert.match(error.message, /PORT: Expected a number/);
    assert.match(error.message, /LOG_LEVEL: Expected one of/);
    assert.match(error.message, /ANTHROPIC_API_KEY: Invalid value \(secret, not shown\)/);
    assert.doesNotMatch(error.message, /tiny9/);
    assert.match(error.fix!, /\.env/);
    const details = error.details as { environment: string; issues: { key: string; code: string; message: string }[] };
    assert.equal(details.environment, "development");
    assert.deepEqual(details.issues.map((i) => i.key).sort(), ["ANTHROPIC_API_KEY", "DATABASE_URL", "LOG_LEVEL", "PORT"]);
    assert.doesNotMatch(JSON.stringify(details), /tiny9/);
  });

  test("per-environment values apply when a variable is not set, and the environment wins over them", () => {
    const options = {
      schema,
      environments: {
        test: { DATABASE_URL: "memory", ANTHROPIC_API_KEY: "sk-test-0000000000", LOG_LEVEL: "warn" },
        production: { LOG_LEVEL: "error", DEBUG: false },
      },
    } as const;
    only({ NODE_ENV: "test" });
    const testing = config(options);
    assert.equal(testing.DATABASE_URL, "memory");
    assert.equal(testing.LOG_LEVEL, "warn");

    only({ NODE_ENV: "test", LOG_LEVEL: "debug" });
    assert.equal(config(options).LOG_LEVEL, "debug");

    only({ DATABASE_URL: "postgres://prod", ANTHROPIC_API_KEY: "sk-ant-1234567890" });
    assert.equal(config({ ...options, environment: "production" }).LOG_LEVEL, "error");

    only({ NODE_ENV: "production" });
    const error = thrown(() => config(options));
    assert.equal(error.code, "IL7003");
    assert.equal((error.details as { environment: string }).environment, "production");
    assert.match(error.message, /production/);
  });

  test("INFERLO_ENV picks the environment before NODE_ENV", () => {
    only({ INFERLO_ENV: "staging", NODE_ENV: "production" });
    const settings = config({
      schema: t.object({ NAME: t.string() }),
      environments: { staging: { NAME: "staging" }, production: { NAME: "production" } },
    });
    assert.equal(settings.NAME, "staging");
  });

  test("invalid options raise IL7004", () => {
    only({});
    assert.equal(thrown(() => config({ schema: t.string() as never })).code, "IL7004");
    const secret = thrown(() => config({ schema, secrets: ["DATABASE_UR" as never] }));
    assert.equal(secret.code, "IL7004");
    assert.match(secret.message, /DATABASE_URL/);
    const env = thrown(() => config({ schema, environments: { test: { PROT: "1" } as never } }));
    assert.equal(env.code, "IL7004");
    assert.match(env.message, /PORT/);
    assert.equal(thrown(() => config({ schema, environments: { test: "x" as never } })).code, "IL7004");
    assert.equal(thrown(() => config({ schema: t.object({ nested: t.object({ a: t.string() }) }) })).code, "IL7004");
  });
});
