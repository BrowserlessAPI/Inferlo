/**
 * File uploads: t.file() fields in multipart/form-data route bodies.
 *
 *   route.post("/avatar", { body: t.object({ avatar: t.file({ maxBytes: 2_000_000, types: ["image/png", "image/jpeg"] }) }) })
 *     .handle(async ({ body }) => ({ name: body.avatar.name, size: body.avatar.size }))
 *
 * The body is read with a byte limit (maxBodySize plus every file field's maxBytes), so a too large upload is cut off
 * while it streams in, and every size, type and content check runs before the handler.
 */
import { InferloError } from "./errors.ts";
import { containsFile, type AnySchema, type Issue } from "./schema.ts";

/** Where a t.file() is allowed in a route, checked once by createApp. */
export function checkFileFields(route: { method: string; path: string; options: object }): void {
  const options = route.options as Record<string, unknown>;
  const where = `${route.method} ${route.path}`;
  for (const key of ["query", "params", "response", "message"]) {
    const schema = options[key] as AnySchema | undefined;
    if (schema && containsFile(schema)) {
      throw new InferloError("IL1004", `Route ${where} uses t.file() in its ${key} schema; files can only be sent in a request body.`, {
        fix: "Move the t.file() field to body: t.object({ file: t.file() }); the client sends it as multipart/form-data.",
      });
    }
  }
  const body = options.body as AnySchema | undefined;
  if (!body || !containsFile(body)) return;
  if (body.def.kind !== "object") {
    throw new InferloError("IL1004", `Route ${where}: a body with files must be t.object({ ... }) with t.file() fields.`, {
      fix: "Use body: t.object({ file: t.file(), title: t.string() }).",
    });
  }
  for (const [name, field] of Object.entries(body.def.shape ?? {})) {
    if (!containsFile(field)) continue;
    const d = field.def;
    if (d.kind === "file") continue;
    if (d.kind === "array" && d.item!.def.kind === "file") {
      if (d.max === undefined) {
        throw new InferloError("IL1004", `Route ${where}: the file list "${name}" has no .max(n), so the size of an upload would have no limit.`, {
          fix: `Limit the number of files: ${name}: t.array(t.file({ maxBytes: 5_000_000 })).max(10).`,
        });
      }
      continue;
    }
    throw new InferloError("IL1004", `Route ${where}: "${name}" nests t.file() inside another schema; multipart form fields are flat.`, {
      fix: `Make it a top-level field of the body: ${name}: t.file(), or ${name}: t.array(t.file()).max(10) for several files.`,
    });
  }
  if (options.tool) {
    throw new InferloError("IL1004", `Route ${where} takes files, so it cannot be an MCP or AI tool (tools send JSON).`, {
      fix: "Remove tool from this route, or add a route that takes a URL or text instead of the file for agents.",
    });
  }
}

/** Bytes the file fields of a body may add on top of maxBodySize (0 without files). */
export function fileBudget(body: AnySchema | undefined): number {
  if (!body || body.def.kind !== "object") return 0;
  let total = 0;
  for (const field of Object.values(body.def.shape ?? {})) {
    const d = field.def;
    if (d.kind === "file") total += d.max ?? 0;
    else if (d.kind === "array" && d.item!.def.kind === "file") total += (d.item!.def.max ?? 0) * (d.max ?? 0);
  }
  return total;
}

export function isMultipart(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("multipart/form-data");
}

/**
 * The fields of a multipart/form-data body as an object for the body schema. Repeated fields become lists, a single
 * value of a list field becomes a one-item list, empty file inputs (no file chosen) count as left out, and the
 * sessions() CSRF field _csrf is dropped.
 */
export async function readMultipart(bytes: Uint8Array, contentType: string, body: AnySchema): Promise<Record<string, unknown>> {
  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new InferloError("IL2015", "Request body is not valid multipart/form-data.", {
      status: 400,
      fix: "Send a FormData body without setting Content-Type yourself (fetch adds the boundary), or a form with enctype=\"multipart/form-data\".",
    });
  }
  const shape = body.def.kind === "object" ? (body.def.shape ?? {}) : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key === "_csrf") continue;
    // A file input with no file chosen is sent as an empty part with an empty filename, which some runtimes read
    // as an empty file and others as an empty string.
    if (typeof value !== "string" ? value.size === 0 && !value.name : value === "" && shape[key] && containsFile(shape[key])) continue;
    const current = out[key];
    if (current === undefined) out[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else out[key] = [current, value];
  }
  for (const [key, value] of Object.entries(out)) {
    if (shape[key]?.def.kind === "array" && !Array.isArray(value)) out[key] = [value];
  }
  return out;
}

// The first bytes of the types whose content is checked against the declared type.
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => starts(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"),
  "image/webp": (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP"),
  "application/pdf": (b) => ascii(b, 0, "%PDF-"),
  "application/zip": (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]) || starts(b, [0x50, 0x4b, 0x05, 0x06]),
};

function starts(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** Media types whose first bytes Inferlo checks when a t.file() field limits its types. */
export const CHECKED_FILE_TYPES: readonly string[] = Object.keys(SIGNATURES);

/**
 * Checks that files of a field with types declare a type whose content matches (a PNG is a PNG), so a client cannot
 * pass a script off as an image by naming its type. Returns validation issues; empty when every file passes.
 */
export async function checkFileContents(body: AnySchema, value: Record<string, unknown>): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const [key, field] of Object.entries(body.def.shape ?? {})) {
    const fileDef = field.def.kind === "file" ? field.def : field.def.kind === "array" && field.def.item!.def.kind === "file" ? field.def.item!.def : undefined;
    if (!fileDef?.fileTypes?.length) continue;
    const files = Array.isArray(value[key]) ? (value[key] as File[]) : value[key] === undefined || value[key] === null ? [] : [value[key] as File];
    for (const [i, file] of files.entries()) {
      const declared = file.type.split(";")[0]!.trim().toLowerCase();
      const matches = SIGNATURES[declared];
      if (!matches) continue;
      const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (!matches(head)) {
        issues.push({ path: Array.isArray(value[key]) ? [key, i] : [key], code: "file_content", message: `File content does not match its type ${declared}.` });
      }
    }
  }
  return issues;
}
