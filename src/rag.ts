/**
 * Retrieval-augmented generation in two calls: rag(table, { ai }) splits documents into chunks, embeds them with
 * ai.embed and stores them in a table with a t.vector() field; search() embeds a question and returns the closest
 * chunks, ready to put in a prompt.
 *
 *   export const Chunk = model("doc_chunks", { documentId: t.ref("documents"), ownerId: t.ref("users"), text: t.text(), embedding: t.vector(1536).index() });
 *
 *   const docs = rag(db.doc_chunks, { ai, model: "embed" });
 *   await docs.add({ text: body.text, fields: { documentId: doc.id, ownerId: user.id }, for: user.id });
 *   const hits = await docs.search({ query: body.question, where: { ownerId: user.id }, limit: 5, for: user.id });
 *   const { text } = await ai.generate({ model: "fast", system: `Answer from these notes:\n\n${hits.map((h) => h.text).join("\n\n---\n\n")}`, prompt: body.question });
 */
import { InferloError } from "./errors.ts";
import type { AI } from "./ai/index.ts";
import type { AnyModel, CreateInput, Row } from "./model.ts";
import { ValidationError, type AnySchema } from "./schema.ts";
import type { Table, Where } from "./db/table.ts";

export interface ChunkOptions {
  /** Longest chunk in characters (default 1000). Paragraphs, then sentences, then words are kept together when they fit. */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next one, so a sentence cut at a border keeps its context (default 100, less than maxChars). */
  overlap?: number;
}

/**
 * Splits text into chunks of at most maxChars characters for embedding: paragraphs first, then sentences, then
 * words (a word longer than maxChars is cut). Each chunk after the first starts with up to overlap characters of the
 * end of the previous one, from a word boundary. Whitespace inside chunks is kept; empty text gives no chunks.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const { maxChars, overlap } = checkChunkOptions(options);
  if (typeof text !== "string") throw ragError(`chunkText() takes a string, got ${text === null ? "null" : typeof text}.`, "Pass the document's text.");
  const pieces = split(text.replace(/\r\n/g, "\n").trim(), maxChars - overlap);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current ? `${current}${piece.separator}${piece.text}` : piece.text;
    if (joined.length <= maxChars - (chunks.length ? overlap : 0) || !current) current = joined;
    else {
      chunks.push(current);
      current = piece.text;
    }
  }
  if (current) chunks.push(current);
  if (!overlap) return chunks;
  return chunks.map((chunk, i) => (i === 0 ? chunk : `${tail(chunks[i - 1]!, overlap)}${chunk}`));
}

interface Piece {
  text: string;
  /** What joined this piece to the one before it in the source. */
  separator: string;
}

/** Paragraphs, then sentences, then words, each at most max characters. */
function split(text: string, max: number): Piece[] {
  if (!text) return [];
  const out: Piece[] = [];
  const levels: [RegExp, string][] = [
    [/\n\s*\n/, "\n\n"],
    [/(?<=[.!?])\s+/, " "],
    [/\s+/, " "],
  ];
  const visit = (part: string, level: number, separator: string) => {
    if (part.length <= max) {
      out.push({ text: part, separator });
      return;
    }
    const rule = levels[level];
    if (!rule) {
      // One word longer than a chunk: cut it.
      for (let i = 0; i < part.length; i += max) out.push({ text: part.slice(i, i + max), separator: i === 0 ? separator : "" });
      return;
    }
    const parts = part.split(rule[0]).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1) return visit(parts[0]!, level + 1, separator);
    parts.forEach((p, i) => visit(p, level + 1, i === 0 ? separator : rule[1]));
  };
  visit(text, 0, "");
  return out;
}

/** The last characters of a chunk and a space, at most n in all, starting at a word. */
function tail(chunk: string, n: number): string {
  if (n < 2) return "";
  if (chunk.length < n) return `${chunk} `;
  const end = chunk.slice(-(n - 1));
  const space = end.search(/\s/);
  const words = space === -1 ? end : end.slice(space).trimStart();
  return words ? `${words} ` : "";
}

function checkChunkOptions(options: ChunkOptions): { maxChars: number; overlap: number } {
  if (!options || typeof options !== "object") throw ragError("Chunk options must be an object: { maxChars, overlap }.");
  const maxChars = options.maxChars ?? 1000;
  const overlap = options.overlap ?? Math.min(100, Math.floor(maxChars / 10));
  if (!Number.isInteger(maxChars) || maxChars < 50 || maxChars > 100_000) throw ragError(`chunk maxChars must be a whole number from 50 to 100000, got ${String(maxChars)}.`);
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > maxChars / 2) throw ragError(`chunk overlap must be a whole number from 0 to half of maxChars (${Math.floor(maxChars / 2)}), got ${String(overlap)}.`);
  return { maxChars, overlap };
}

function ragError(message: string, fix = "See docs/ai.md#retrieval-rag."): InferloError {
  return new InferloError("IL5038", message, { fix });
}

type StringField<R> = { [K in keyof R & string]: NonNullable<R[K]> extends string ? K : never }[keyof R & string];
type VectorFieldOf<R> = { [K in keyof R & string]: NonNullable<R[K]> extends number[] ? K : never }[keyof R & string];

export interface RagOptions<M extends AnyModel> {
  /** The AI client: ctx.ai in a route, app.ai or createAI() elsewhere. */
  ai: AI;
  /** Embedding model alias or "provider:model" (default: the "embed" alias, as ai.embed). */
  model?: string;
  /** The text field of a chunk (default "text"). */
  textField?: StringField<Row<M>>;
  /** The t.vector() field (default: the model's only one). */
  vectorField?: VectorFieldOf<Row<M>>;
  /** How add() splits text (default maxChars 1000, overlap 100). */
  chunk?: ChunkOptions;
}

export interface RagAddOptions<M extends AnyModel> {
  /** The document's text. It is split into chunks; each chunk is one row. */
  text: string;
  /** The other fields of every chunk row, such as documentId and ownerId. */
  fields?: Partial<CreateInput<M>>;
  /** Who the embedding calls are for (usage tracking and budgets). */
  for?: string;
  signal?: AbortSignal;
}

export interface RagSearchOptions<M extends AnyModel> {
  /** The question. It is embedded with the same model as the chunks. */
  query: string;
  /** Only search chunks matching this filter, such as { ownerId: user.id }. */
  where?: Where<Row<M>>;
  /** Most chunks returned (default 5, at most 100). */
  limit?: number;
  /** Leave out chunks further than this cosine distance (0 to 2). */
  maxDistance?: number;
  for?: string;
  signal?: AbortSignal;
}

export interface RagHit<M extends AnyModel> {
  /** The chunk's text, to put in a prompt. */
  text: string;
  /** Cosine distance to the question: 0 is the same direction. */
  distance: number;
  /** The whole chunk row, with its other fields (documentId, ...). */
  row: Row<M>;
}

export interface Rag<M extends AnyModel> {
  /** Splits text into chunks, embeds them in one ai.embed call and inserts one row per chunk. Returns the rows. */
  add(options: RagAddOptions<M>): Promise<Row<M>[]>;
  /** Embeds the query and returns the closest chunks, closest first. */
  search(options: RagSearchOptions<M>): Promise<RagHit<M>[]>;
}

/** Most chunks one add() call embeds and stores. Split larger documents and call add() for each part. */
const MAX_CHUNKS = 1000;

/**
 * Chunks, embeddings and vector search on a table with a text field and a t.vector() field:
 * const docs = rag(db.doc_chunks, { ai, model: "embed" }); await docs.add({ text, fields }); await docs.search({ query }).
 */
export function rag<M extends AnyModel>(table: Table<M, any>, options: RagOptions<M>): Rag<M> {
  if (!table || typeof table !== "object" || !("model" in table) || typeof (table as { search?: unknown }).search !== "function") {
    throw ragError("rag() takes a table client, such as db.doc_chunks.", "Pass the table that stores the chunks: rag(db.doc_chunks, { ai }).");
  }
  if (!options || typeof options !== "object" || !options.ai || typeof options.ai.embed !== "function") {
    throw ragError("rag() needs { ai }: ctx.ai in a route, app.ai, or what createAI() returns.", "Pass the AI client: rag(db.doc_chunks, { ai: ctx.ai, model: \"embed\" }).");
  }
  const model = table.model;
  const fields = model.fields as Record<string, AnySchema>;
  const textField = (options.textField as string | undefined) ?? "text";
  const textKind = fields[textField]?.def.kind;
  if (!textKind || !["text", "string"].includes(textKind)) {
    throw ragError(`"${model.name}" has no text field "${textField}" for the chunks.`, `Add text: t.text() to the model, or pass textField.`);
  }
  const vectors = Object.keys(fields).filter((f) => fields[f]!.def.kind === "vector");
  const vectorField = (options.vectorField as string | undefined) ?? (vectors.length === 1 ? vectors[0] : undefined);
  if (!vectorField || !vectors.includes(vectorField)) {
    throw ragError(
      vectors.length > 1 && !options.vectorField ? `"${model.name}" has several t.vector() fields (${vectors.join(", ")}); pass vectorField.` : `"${model.name}" has no t.vector() field${options.vectorField ? ` "${String(options.vectorField)}"` : ""} for the embeddings.`,
      "Add embedding: t.vector(1536).index() to the model (the length of your embedding model's vectors).",
    );
  }
  const chunking = checkChunkOptions(options.chunk ?? {});
  const embedModel = options.model;
  const embed = (input: string[], forId: string | undefined, signal: AbortSignal | undefined) =>
    options.ai.embed({ ...(embedModel ? { model: embedModel } : {}), input, ...(forId ? { for: forId } : {}), ...(signal ? { signal } : {}) });

  return {
    async add(add) {
      if (!add || typeof add !== "object" || typeof add.text !== "string") throw ragError("add() takes { text, fields }, with the document's text as a string.");
      if (add.fields !== undefined && (typeof add.fields !== "object" || add.fields === null)) throw ragError("add() fields must be an object of the other fields of each chunk row.");
      if (add.fields && (textField in add.fields || vectorField in add.fields)) {
        throw ragError(`add() fields cannot set "${textField}" or "${vectorField}": rag() fills them in for each chunk.`);
      }
      const chunks = chunkText(add.text, chunking);
      if (!chunks.length) return [];
      if (chunks.length > MAX_CHUNKS) {
        throw ragError(`The text makes ${chunks.length} chunks; one add() call stores at most ${MAX_CHUNKS}.`, "Split the document into parts and call add() for each, or raise chunk.maxChars.");
      }
      const { embeddings } = await embed(chunks, add.for, add.signal);
      if (embeddings.length !== chunks.length) throw ragError(`The embedding model returned ${embeddings.length} vectors for ${chunks.length} chunks.`, "Use an embedding model alias in rag({ model }).");
      // Every row is validated before any is stored, so a wrong field or vector size stores nothing.
      const rows = chunks.map((text, i) => ({ ...(add.fields ?? {}), [textField]: text, [vectorField]: embeddings[i] }) as CreateInput<M>);
      for (const row of rows) {
        const result = model.create.safeParse(row);
        if (!result.ok) throw new ValidationError(result.issues, `${model.name} insert`);
      }
      return table.insertMany(rows);
    },

    async search(search) {
      if (!search || typeof search !== "object" || typeof search.query !== "string" || !search.query.trim()) {
        throw ragError("search() takes { query } with the question as a non-empty string.");
      }
      const limit = search.limit ?? 5;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw ragError(`search() limit must be a whole number from 1 to 100, got ${String(limit)}.`);
      if (search.maxDistance !== undefined && (typeof search.maxDistance !== "number" || !(search.maxDistance >= 0 && search.maxDistance <= 2))) {
        throw ragError(`search() maxDistance must be a number from 0 to 2, got ${String(search.maxDistance)}.`);
      }
      const { embeddings } = await embed([search.query], search.for, search.signal);
      const hits = await table.search({ vector: embeddings[0]!, field: vectorField as never, where: search.where, limit });
      return hits
        .filter((hit) => search.maxDistance === undefined || hit.distance <= search.maxDistance)
        .map((hit) => ({ text: String((hit.row as Record<string, unknown>)[textField] ?? ""), distance: hit.distance, row: hit.row }));
    },
  };
}
