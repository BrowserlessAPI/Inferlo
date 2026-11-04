import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { mockProvider } from "../../../src/ai/public.ts";

// NestJS uses decorators, which Node cannot run from TypeScript source, so the test compiles src/ the way
// tsc does for a Nest app (experimentalDecorators, emitDecoratorMetadata) and runs the output.
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", ".compiled");
before(() => {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const options = ts.getParsedCommandLineOfConfigFile(path.join(here, "..", "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!.options;
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
  const nest = await bootstrap(mock());
  await nest.listen(0, "127.0.0.1");
  return { nest, base: `http://127.0.0.1:${nest.getHttpServer().address().port}` };
}

test("a Nest controller uses the injected AI client with structured output", async () => {
  const { nest, base } = await start();
  try {
    const res = await fetch(`${base}/classify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "How do I export?" }) });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { label: "question" });
  } finally {
    await nest.close();
  }
});

test("the Inferlo app under /api keeps its auth, validation and OpenAPI", async () => {
  const { nest, base } = await start();
  try {
    const json = { "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/summaries`, { method: "POST", headers: json, body: JSON.stringify({ text: "x" }) })).status, 401);
    const signedIn = { ...json, authorization: "Bearer demo-token" };
    assert.equal((await fetch(`${base}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "" }) })).status, 422);
    const ok = await fetch(`${base}/api/summaries`, { method: "POST", headers: signedIn, body: JSON.stringify({ text: "A long text." }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { summary: "A short summary." });
    assert.ok((await (await fetch(`${base}/api/openapi.json`)).json()).paths["/summaries"]);
  } finally {
    await nest.close();
  }
});
