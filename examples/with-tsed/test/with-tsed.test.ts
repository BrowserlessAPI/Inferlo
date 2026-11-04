import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mockProvider } from "../../../src/ai/public.ts";

// Ts.ED uses decorators, which Node cannot run from TypeScript source, so the test compiles src/ the way
// tsc does for a Ts.ED app (experimentalDecorators, emitDecoratorMetadata) and runs the output. The compiler
// API is loaded untyped: this repo's TypeScript (5.x) has it, while TypeScript 7 (tested in CI for
// typechecking only) ships without a JavaScript API.
const ts: any = (await import("typescript" as string)).default;
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", ".compiled");
before(() => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const options = ts.getParsedCommandLineOfConfigFile(path.join(here, "..", "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }).options;
  for (const file of readdirSync(path.join(here, "..", "src"))) {
    const source = readFileSync(path.join(here, "..", "src", file), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { ...options, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: false, noEmit: false }, fileName: file });
    writeFileSync(path.join(out, file), outputText);
  }
});
after(() => rmSync(out, { recursive: true, force: true }));

const mock = () => ({
  providers: { anthropic: mockProvider({ respond: (request) => (JSON.stringify(request).includes("JSON Schema") ? '{"label":"question"}' : "A short summary.") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

async function start() {
  const { bootstrap } = await import(path.join(out, "main.ts"));
  const platform = await bootstrap(mock(), "127.0.0.1:0");
  await platform.listen();
  // After listen(), Ts.ED sets httpPort to the address it listens on ("127.0.0.1:54321").
  return { platform, base: `http://${platform.settings.get("httpPort")}` };
}

test("a Ts.ED controller uses the AI client injected as InferloAI, with structured output", async () => {
  const { platform, base } = await start();
  try {
    const res = await fetch(`${base}/classify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "How do I export?" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { label: "question" });
  } finally {
    await platform.stop();
  }
});

test("the Inferlo app under /api keeps its auth, validation and OpenAPI", async () => {
  const { platform, base } = await start();
  try {
    const json = { "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/summaries`, { method: "POST", headers: json, body: JSON.stringify({ text: "x" }) })).status, 401);
    const signedIn = { ...json, authorization: "Bearer demo-token" };
    assert.equal((await fetch(`${base}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) })).status, 422);
    const ok = await fetch(`${base}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "A long text." }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { summary: "A short summary." });
    assert.ok((await (await fetch(`${base}/api/openapi.json`)).json()).paths["/summaries"]);
    // Ts.ED still answers its own routes and 404s outside /api.
    assert.equal((await fetch(`${base}/nothing-here`)).status, 404);
  } finally {
    await platform.stop();
  }
});
