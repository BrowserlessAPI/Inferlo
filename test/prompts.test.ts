import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAI, InferloError, mockProvider, parsePromptFile, prompt, t, type Usage } from "../src/index.ts";
import { promptsModule } from "../src/prompt.ts";

// Versioned prompts with typed variables: prompt() in code, src/prompts/*.md files, and `inferlo prompts`, which
// writes src/prompts/index.ts from the files.

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

const FILE = `---
version: 2
description: Summarize a support ticket
variables:
  title: string
  body: text
  urgent: boolean
---
## System
You summarize support tickets in two sentences.

## Prompt
Summarize the ticket "{{title}}" (urgent: {{ urgent }}):

{{body}}
`;

const code = (e: InferloError) => e.code === "IL5039";

describe("prompt()", () => {
  const summarize = prompt({
    name: "summarize-ticket",
    version: "2",
    system: "You summarize tickets for {{team}}.",
    text: "Summarize {{title}}.",
    variables: t.object({ title: t.string().max(200), team: t.string() }),
  });

  test("render() validates the variables and fills in system and prompt, with the prompt id", () => {
    assert.equal(summarize.id, "summarize-ticket@2");
    assert.deepEqual(summarize.render({ title: "Printer on fire", team: "IT" }), {
      system: "You summarize tickets for IT.",
      prompt: "Summarize Printer on fire.",
      promptId: "summarize-ticket@2",
    });
    assert.throws(() => summarize.render({ title: "x" } as never), (e: InferloError) => e.code === "IL1001");
    assert.throws(() => summarize.render({ title: "x".repeat(201), team: "IT" }), (e: InferloError) => e.code === "IL1001");
  });

  test("ai.generate records the prompt id in usage", async () => {
    const usage: Usage[] = [];
    const provider = mockProvider({ respond: (r) => r.messages.map((m) => m.content).join(" | ") });
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, onUsage: (u) => void usage.push(u) });
    const { text } = await ai.generate({ model: "fast", ...summarize.render({ title: "Login broken", team: "Web" }) });
    assert.equal(text, "You summarize tickets for Web. | Summarize Login broken.");
    assert.equal(usage[0]!.prompt, "summarize-ticket@2");
    await ai.stream({ model: "fast", ...summarize.render({ title: "a", team: "b" }) }).text();
    assert.equal(usage[1]!.prompt, "summarize-ticket@2");
    await ai.generate({ model: "fast", prompt: "plain" });
    assert.equal(usage[2]!.prompt, undefined);
  });

  test("undeclared, unused and invalid placeholders, names and versions raise IL5039", () => {
    const base = { name: "p", version: "1", text: "Hi {{name}}", variables: t.object({ name: t.string() }) };
    assert.doesNotThrow(() => prompt(base));
    assert.throws(() => prompt({ ...base, text: "Hi {{other}}" }), (e: InferloError) => code(e) && /not declared/.test(e.message));
    assert.throws(() => prompt({ ...base, text: "Hi" }), (e: InferloError) => code(e) && /never uses/.test(e.message));
    assert.throws(() => prompt({ ...base, text: "Hi {{name.first}}" }), code);
    assert.throws(() => prompt({ ...base, name: "Bad Name" }), code);
    assert.throws(() => prompt({ ...base, version: "" }), code);
    assert.throws(() => prompt({ ...base, text: "  " }), code);
    assert.throws(() => prompt({ ...base, variables: undefined as never }), code);
  });
});

describe("prompt files", () => {
  test("parsePromptFile reads front matter, the system message and the prompt", () => {
    assert.deepEqual(parsePromptFile(FILE, "summarize-ticket.md"), {
      name: "summarize-ticket",
      version: "2",
      description: "Summarize a support ticket",
      system: "You summarize support tickets in two sentences.",
      text: 'Summarize the ticket "{{title}}" (urgent: {{ urgent }}):\n\n{{body}}',
      variables: { title: "string", body: "text", urgent: "boolean" },
    });
    const plain = parsePromptFile("---\nversion: 1\n---\nSay hello.\n", "src/prompts/hello.md");
    assert.deepEqual(plain, { name: "hello", version: "1", text: "Say hello.", variables: {} });
  });

  test("invalid files raise IL5039 with the file and line", () => {
    const bad = [
      "version: 1\nHi",
      "---\nversion: 1\nHi",
      "---\nvariables:\n  a: string\n---\n{{a}}",
      "---\nversion: 1\nmodel: fast\n---\nHi",
      "---\nversion: 1\nvariables:\n  a: date\n---\n{{a}}",
      "---\nversion: 1\n  a: string\n---\n{{a}}",
      "---\nversion: 1\n---\n## System\nOnly a system message",
      "---\nversion: 1\n---\nstray\n## Prompt\nHi",
      "---\nversion: 1\n---\n",
    ];
    for (const source of bad) assert.throws(() => parsePromptFile(source, "x.md"), (e: InferloError) => code(e) && /src\/prompts\/x\.md/.test(e.message), source);
  });

  test("promptsModule writes typed prompt() calls that render like the file says", async () => {
    const source = promptsModule([parsePromptFile(FILE, "summarize-ticket.md"), parsePromptFile("---\nversion: 1\n---\nSay hello.", "hello.md")], "../src/index.ts");
    assert.match(source, /^\/\/ Generated by `inferlo prompts`/);
    assert.match(source, /export const summarizeTicket = prompt\(\{/);
    assert.match(source, /variables: t\.object\(\{ title: t\.string\(\), body: t\.text\(\), urgent: t\.boolean\(\) \}\)/);
    assert.match(source, /export const hello = prompt\(\{/);
    const dir = await mkdtemp(path.join(fileURLToPath(new URL(".", import.meta.url)), ".prompts-"));
    try {
      await writeFile(path.join(dir, "index.ts"), source.replace('"../src/index.ts"', JSON.stringify(path.relative(dir, fileURLToPath(new URL("../src/index.ts", import.meta.url))))));
      const mod = await import(path.join(dir, "index.ts"));
      assert.deepEqual(mod.summarizeTicket.render({ title: "VPN", body: "Down since 9.", urgent: true }), {
        system: "You summarize support tickets in two sentences.",
        prompt: 'Summarize the ticket "VPN" (urgent: true):\n\nDown since 9.',
        promptId: "summarize-ticket@2",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.throws(() => promptsModule([parsePromptFile("---\nversion: 1\nvariables:\n  a: string\n---\nHi", "x.md")]), code);
  });

  test("inferlo prompts writes src/prompts/index.ts, and --check fails when it is out of date", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "inferlo-prompts-"));
    try {
      await mkdir(path.join(dir, "src", "prompts"), { recursive: true });
      await writeFile(path.join(dir, "src", "prompts", "summarize-ticket.md"), FILE);
      const out = await run("node", [CLI, "prompts", "--json"], { cwd: dir });
      assert.deepEqual(JSON.parse(out.stdout), { ok: true, written: "src/prompts/index.ts", prompts: ["summarize-ticket@2"] });
      const written = await readFile(path.join(dir, "src", "prompts", "index.ts"), "utf8");
      assert.match(written, /import \{ prompt, t \} from "@browserlessapi\/inferlo";/);
      assert.match(written, /export const summarizeTicket = prompt/);
      const check = await run("node", [CLI, "prompts", "--check", "--json"], { cwd: dir });
      assert.equal(JSON.parse(check.stdout).ok, true);
      await writeFile(path.join(dir, "src", "prompts", "summarize-ticket.md"), FILE.replace("version: 2", "version: 3"));
      const stale = await run("node", [CLI, "prompts", "--check", "--json"], { cwd: dir }).catch((e: { stdout: string; code: number }) => e);
      assert.equal((stale as { code: number }).code, 1);
      assert.equal(JSON.parse((stale as { stdout: string }).stdout).error.code, "IL8009");
      await writeFile(path.join(dir, "src", "prompts", "broken.md"), "no front matter");
      const broken = await run("node", [CLI, "prompts", "--json"], { cwd: dir }).catch((e: { stdout: string }) => e);
      assert.equal(JSON.parse((broken as { stdout: string }).stdout).error.code, "IL5039");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
