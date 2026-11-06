import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { postgres } from "../src/db/postgres.ts";
import { databaseJobStore } from "../src/jobs.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repo, "src", "cli", "main.ts");
const index = JSON.stringify(path.join(repo, "src", "index.ts"));
const pgModule = JSON.stringify(path.join(repo, "src", "db", "postgres.ts"));
const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;

function project(appSource: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "inferlo-worker-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(path.join(dir, "src", "app.ts"), appSource);
  return dir;
}

describe("inferlo worker", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const cli = (dir: string) => spawnSync(process.execPath, [cliPath, "worker", "--json"], { cwd: dir, encoding: "utf8" });

  test("an app without jobs raises IL8007", () => {
    const dir = project(`import { createApp } from ${index};\nexport const app = createApp({ logger: { info() {}, error() {} } });\n`);
    dirs.push(dir);
    const r = cli(dir);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "IL8007");
    // CLI errors always include the real message and the fix, even for 500 errors.
    assert.match(out.error.message, /no jobs|jobs/i);
    assert.notEqual(out.error.message, "Internal server error");
    assert.match(out.error.fix, /createApp\(\{ jobs: \[jobs\] \}\)/);
    assert.match(out.error.docs, /il8007$/);
  });

  test("the in-memory queue raises IL8008, because another process cannot see it", () => {
    const dir = project(
      `import { createApp, job, t } from ${index};\nconst ping = job("ping", { input: t.object({}) }).handle(() => {});\nexport const app = createApp({ jobs: [ping], logger: { info() {}, error() {} } });\n`,
    );
    dirs.push(dir);
    const r = cli(dir);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "IL8008");
    assert.match(out.message, /shared job queue/);
    assert.match(out.error.message, /shared job queue/);
    assert.match(out.error.fix, /store: "database"/);
  });

  if (PG_URL) {
    let dir = "";
    const name = `slow-${Date.now().toString(36)}`;
    before(() => {
      dir = project(
        [
          `import { appendFileSync } from "node:fs";`,
          `import { createApp, job, t } from ${index};`,
          `import { postgres } from ${pgModule};`,
          `const slow = job(${JSON.stringify(name)}, { input: t.object({ n: t.int() }) }).handle(async ({ input }) => {`,
          `  appendFileSync("events.log", "start " + input.n + "\\n");`,
          `  await new Promise((r) => setTimeout(r, 400));`,
          `  appendFileSync("events.log", "end " + input.n + "\\n");`,
          `});`,
          `export const app = createApp({ db: postgres({ url: process.env.WORKER_DATABASE_URL! }), jobs: [slow], jobQueue: { store: "database" }, logger: { info() {}, error() {} } });`,
        ].join("\n"),
      );
      dirs.push(dir);
      // .env is read like inferlo dev does.
      writeFileSync(path.join(dir, ".env"), `WORKER_DATABASE_URL=${PG_URL}\n`);
    });

    test("runs queued jobs and finishes the running job on SIGTERM", async () => {
      const db = postgres({ url: PG_URL });
      const store = databaseJobStore(db);
      const now = new Date();
      const id = crypto.randomUUID();
      await store.add({ id, name, input: { n: 1 }, status: "pending", attempts: 0, maxAttempts: 1, runAt: now, createdAt: now, updatedAt: now });

      const child = spawn(process.execPath, [cliPath, "worker", "--json"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));

      const log = path.join(dir, "events.log");
      for (let i = 0; i < 200 && !existsSync(log); i++) await new Promise((r) => setTimeout(r, 25));
      assert.ok(existsSync(log), `the job did not start: ${stdout} ${stderr}`);
      child.kill("SIGTERM");
      const code = await exited;
      // Deno's node:child_process reports the signal passed to kill() (code null) even when the child handles it and
      // exits with 0, so there the "stopped" line below shows the graceful exit.
      if (!("Deno" in globalThis)) assert.equal(code, 0, stderr);

      const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(lines[0], { ok: true, event: "started", jobs: [name], queue: "database" });
      assert.equal(lines.at(-1).event, "stopped");
      const { readFileSync } = await import("node:fs");
      assert.equal(readFileSync(log, "utf8"), "start 1\nend 1\n");
      assert.equal((await store.get(id))?.status, "done");
      await db.close?.();
    });
  }
});
