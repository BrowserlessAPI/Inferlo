/**
 * Versioned prompts with typed variables. A prompt lives in src/prompts/<name>.md:
 *
 *   ---
 *   version: 2
 *   description: Summarize a support ticket
 *   variables:
 *     title: string
 *     body: text
 *   ---
 *   ## System
 *   You summarize support tickets in two sentences.
 *
 *   ## Prompt
 *   Summarize the ticket "{{title}}":
 *
 *   {{body}}
 *
 * `inferlo prompts` turns the files into src/prompts/index.ts (prompt() calls), so routes import them like any
 * module and the variables are typed: ai.generate({ model: "fast", ...summarizeTicket.render({ title, body }) }).
 * Usage and traces name the prompt and its version ("summarize-ticket@2").
 */
import { InferloError } from "./errors.ts";
import { t, type AnySchema, type InferInput, type ObjectSchema, type Shape } from "./schema.ts";

/** Variable types a prompt file can declare. */
export type PromptVariableType = "string" | "text" | "number" | "int" | "boolean";

export interface PromptDefinition<S extends Shape> {
  /** Stable name: the file name without .md ("summarize-ticket"). */
  name: string;
  /** Version of the prompt. Change it whenever the text changes, so usage and traces show which one answered. */
  version: string;
  description?: string;
  /** System message template (optional). */
  system?: string;
  /** User message template. */
  text: string;
  /** The variables the templates use, as {{name}}. */
  variables: ObjectSchema<S>;
}

/** What render() returns: spread it into ai.generate or ai.stream. */
export interface RenderedPrompt {
  system?: string;
  prompt: string;
  /** "name@version", recorded in usage and traces. */
  promptId: string;
}

export interface Prompt<S extends Shape> {
  readonly name: string;
  readonly version: string;
  /** "name@version". */
  readonly id: string;
  readonly description?: string;
  readonly variables: ObjectSchema<S>;
  /** Fills in the variables (validated: IL1001 for missing or wrong values) and returns { system, prompt, promptId }. */
  render(variables: InferInput<ObjectSchema<S>>): RenderedPrompt;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const VARIABLE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function invalid(message: string, fix = "See docs/ai.md#prompt-files."): InferloError {
  return new InferloError("IL5039", message, { fix });
}

/** The {{names}} a template uses. Raises IL5039 for placeholders that are not plain names. */
function placeholders(template: string, where: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!VARIABLE.test(name)) throw invalid(`${where} has the placeholder "{{${name}}}", which is not a variable name.`, "Use {{name}} with letters, digits and underscores only.");
    out.push(name);
  }
  return out;
}

/**
 * A versioned prompt with typed variables. `inferlo prompts` writes these calls from src/prompts/*.md; they can also
 * be written by hand. Every {{name}} in system and text must be a variable, and every variable must be used.
 */
export function prompt<S extends Shape>(definition: PromptDefinition<S>): Prompt<S> {
  if (!definition || typeof definition !== "object") throw invalid("prompt() takes { name, version, text, variables }.");
  const { name, version, description, system, text, variables } = definition;
  if (typeof name !== "string" || !NAME.test(name)) throw invalid(`A prompt name must be 1 to 64 lowercase letters, digits and dashes, starting with a letter, got ${JSON.stringify(name)}.`, "Name the file like summarize-ticket.md.");
  if (typeof version !== "string" || !/^[\w.-]{1,32}$/.test(version)) throw invalid(`Prompt "${name}" needs a version of 1 to 32 letters, digits, dots, dashes or underscores, got ${JSON.stringify(version)}.`, "Add version: 1 to the front matter, and raise it whenever the text changes.");
  if (typeof text !== "string" || !text.trim()) throw invalid(`Prompt "${name}" has no prompt text.`);
  if (system !== undefined && typeof system !== "string") throw invalid(`Prompt "${name}" has a system message that is not text.`);
  if (!variables || typeof variables !== "object" || variables.def?.kind !== "object") throw invalid(`Prompt "${name}" needs variables: t.object({ ... }) (t.object({}) for none).`);
  const declared = Object.keys(variables.def.shape ?? {});
  const used = new Set([...placeholders(text, `Prompt "${name}"`), ...(system ? placeholders(system, `The system message of prompt "${name}"`) : [])]);
  const unknown = [...used].filter((v) => !declared.includes(v));
  if (unknown.length) throw invalid(`Prompt "${name}" uses ${unknown.map((v) => `{{${v}}}`).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not declared.`, `Declare ${unknown.length === 1 ? "it" : "them"} under variables in the front matter, e.g. ${unknown[0]}: string.`);
  const unused = declared.filter((v) => !used.has(v));
  if (unused.length) throw invalid(`Prompt "${name}" declares ${unused.join(", ")} but never uses ${unused.length === 1 ? "it" : "them"}.`, `Use {{${unused[0]}}} in the text, or remove the variable.`);
  const id = `${name}@${version}`;
  const fill = (template: string, values: Record<string, unknown>) => template.replace(PLACEHOLDER, (_m, key: string) => String(values[key] ?? ""));
  return Object.freeze({
    name,
    version,
    id,
    ...(description ? { description } : {}),
    variables,
    render(input: InferInput<ObjectSchema<S>>): RenderedPrompt {
      const values = variables.parse(input) as Record<string, unknown>;
      return { ...(system ? { system: fill(system, values) } : {}), prompt: fill(text, values), promptId: id };
    },
  });
}

/** A prompt file read by parsePromptFile: the arguments of prompt(), with the variable types as written. */
export interface PromptFile {
  name: string;
  version: string;
  description?: string;
  system?: string;
  text: string;
  variables: Record<string, PromptVariableType>;
}

const TYPES: readonly PromptVariableType[] = ["string", "text", "number", "int", "boolean"];

/**
 * Reads a prompt file: front matter between --- lines (version, description and variables: one "name: type" per
 * indented line), then the text. A "## System" heading starts the system message and "## Prompt" the user message;
 * without headings the whole text is the prompt. Raises IL5039 with the line for anything else.
 */
export function parsePromptFile(source: string, fileName: string): PromptFile {
  const name = fileName.replace(/^.*[\\/]/, "").replace(/\.md$/i, "");
  const where = `src/prompts/${name}.md`;
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") throw invalid(`${where} must start with front matter between --- lines.`, "Start the file with:\n---\nversion: 1\nvariables:\n  title: string\n---");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw invalid(`${where} has no closing --- after its front matter.`);
  const out: PromptFile = { name, version: "", text: "", variables: {} };
  let inVariables = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s+/.test(line);
    const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) throw invalid(`${where} line ${i + 1}: expected "key: value", got ${JSON.stringify(line.trim())}.`);
    const [, key, raw] = match as unknown as [string, string, string];
    const value = raw.replace(/^(["'])(.*)\1$/, "$2");
    if (indented) {
      if (!inVariables) throw invalid(`${where} line ${i + 1}: only variables has indented entries.`);
      if (!TYPES.includes(value as PromptVariableType)) throw invalid(`${where} line ${i + 1}: variable "${key}" has type ${JSON.stringify(value)}.`, `Use one of: ${TYPES.join(", ")}.`);
      if (key in out.variables) throw invalid(`${where} line ${i + 1}: variable "${key}" is declared twice.`);
      out.variables[key] = value as PromptVariableType;
      continue;
    }
    inVariables = false;
    if (key === "version") out.version = value;
    else if (key === "description") out.description = value;
    else if (key === "variables") {
      if (value) throw invalid(`${where} line ${i + 1}: list the variables on the lines below, one "name: type" per indented line.`);
      inVariables = true;
    } else throw invalid(`${where} line ${i + 1}: unknown front matter key "${key}".`, "Use version, description and variables.");
  }
  if (!out.version) throw invalid(`${where} has no version in its front matter.`, "Add version: 1, and raise it whenever the text changes.");
  const body = lines.slice(end + 1);
  const sections: Record<string, string[]> = {};
  let current: string | undefined;
  const before: string[] = [];
  for (const line of body) {
    const heading = /^##\s+(System|Prompt)\s*$/i.exec(line);
    if (heading) {
      current = heading[1]!.toLowerCase();
      if (sections[current]) throw invalid(`${where} has two "## ${heading[1]}" sections.`);
      sections[current] = [];
      continue;
    }
    (current ? sections[current]! : before).push(line);
  }
  const join = (list: string[]) => list.join("\n").trim();
  if (!current) out.text = join(before);
  else {
    if (join(before)) throw invalid(`${where} has text before its first "## System" or "## Prompt" heading.`, "Move it under a heading, or remove the headings to make the whole text the prompt.");
    if (!sections.prompt) throw invalid(`${where} has a "## System" section but no "## Prompt" section.`);
    out.text = join(sections.prompt);
    if (sections.system && join(sections.system)) out.system = join(sections.system);
  }
  if (!out.text) throw invalid(`${where} has no prompt text.`);
  return out;
}

/** The t.* schema of a prompt file's variable type. */
export function promptVariableSchema(type: PromptVariableType): AnySchema {
  return type === "text" ? t.text() : type === "number" ? t.number() : type === "int" ? t.int() : type === "boolean" ? t.boolean() : t.string();
}

/** The TypeScript module `inferlo prompts` writes for a set of prompt files. */
export function promptsModule(files: PromptFile[], importFrom = "@browserlessapi/inferlo"): string {
  const exportName = (name: string) => name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const names = new Map<string, string>();
  for (const file of files) {
    prompt({ ...file, variables: t.object(Object.fromEntries(Object.entries(file.variables).map(([k, v]) => [k, promptVariableSchema(v)]))) });
    const exported = exportName(file.name);
    if (names.has(exported)) throw invalid(`src/prompts/${file.name}.md and src/prompts/${names.get(exported)}.md both become the export "${exported}".`, "Rename one of the files.");
    names.set(exported, file.name);
  }
  const lines = [
    "// Generated by `inferlo prompts` from src/prompts/*.md. Do not edit: change the .md files and run `inferlo prompts` again.",
    `import { prompt, t } from ${JSON.stringify(importFrom)};`,
    "",
  ];
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const shape = Object.entries(file.variables).map(([k, v]) => `${k}: t.${v}()`).join(", ");
    lines.push(`export const ${exportName(file.name)} = prompt({`);
    lines.push(`  name: ${JSON.stringify(file.name)},`);
    lines.push(`  version: ${JSON.stringify(file.version)},`);
    if (file.description) lines.push(`  description: ${JSON.stringify(file.description)},`);
    if (file.system) lines.push(`  system: ${JSON.stringify(file.system)},`);
    lines.push(`  text: ${JSON.stringify(file.text)},`);
    lines.push(`  variables: t.object({${shape ? ` ${shape} ` : ""}}),`);
    lines.push("});", "");
  }
  return lines.join("\n");
}
