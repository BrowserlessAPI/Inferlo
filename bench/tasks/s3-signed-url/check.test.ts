import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ada = { id: "00000000-0000-4000-8000-000000000001", email: "a@x.io", name: "A", roles: ["member"] };
const S3 = { S3_BUCKET: "acme-reports", S3_REGION: "eu-central-1", S3_ENDPOINT: "http://localhost:9000", S3_ACCESS_KEY_ID: "BENCHKEY", S3_SECRET_ACCESS_KEY: "bench-secret-key" };

// Starts src/app.ts in a fresh process (config is read once per process) with the S3 settings.
function start(): { code: number | null; output: string } {
  const env = { ...process.env, ...S3 };
  const script = `const { app } = await import(${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)});
const anon = await app.request("/reports/q3-2026.pdf/link");
const res = await app.request("/reports/q3-2026.pdf/link", { as: ${JSON.stringify(ada)} });
const bad = await app.request("/reports/..%2Fsecret/link", { as: ${JSON.stringify(ada)} });
console.log(JSON.stringify({ store: app.describe().storage, anon: anon.status, status: res.status, location: res.headers.get("location"), bad: bad.status }));
process.exit(0);`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10_000 });
  return { code: run.status, output: run.stdout + run.stderr };
}

test("signed S3 download links", () => {
  assert.match(readFileSync(new URL("../src/app.ts", import.meta.url), "utf8"), /routes:\s*\[[^\]]*reports/, "registers the reports routes");
  const { code, output } = start();
  assert.equal(code, 0, output);
  const result = JSON.parse(output.trim().split("\n").at(-1)!);
  assert.equal(result.store, "s3", "uses the S3 storage store");
  assert.equal(result.anon, 401);
  assert.equal(result.status, 303);
  const link = new URL(result.location);
  assert.equal(link.origin + link.pathname, `http://localhost:9000/acme-reports/reports/${ada.id}/q3-2026.pdf`);
  assert.equal(link.searchParams.get("X-Amz-Expires"), "300");
  assert.match(link.searchParams.get("X-Amz-Credential") ?? "", /^BENCHKEY\/\d{8}\/eu-central-1\/s3\/aws4_request$/);
  assert.match(link.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!result.location.includes("bench-secret-key"));
  assert.notEqual(result.bad, 303, "names that are not plain file names are refused");
});
