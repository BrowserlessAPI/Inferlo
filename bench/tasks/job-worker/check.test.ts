import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(project, "node_modules", "@browserlessapi", "inferlo", "dist", "cli", "main.js");

test("inferlo worker starts with the cleanup-notes job and stops on SIGTERM", async () => {
  // Nothing listens on this port; the worker only has to start and stop cleanly.
  const env = { ...process.env, DATABASE_URL: "postgres://inferlo:none@127.0.0.1:9/none" };
  const child = spawn(process.execPath, [cli, "worker", "--json"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  const started = new Promise<void>((resolve) =>
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.includes("\n")) resolve();
    }),
  );
  await Promise.race([started, exited]);
  const first = JSON.parse(stdout.split("\n")[0] || "{}");
  if (first.event !== "started") {
    child.kill("SIGKILL");
    assert.fail(`inferlo worker did not start: ${stdout} ${stderr}`);
  }
  assert.deepEqual(first.jobs, ["cleanup-notes"]);
  assert.equal(first.queue, "database");
  child.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
});
