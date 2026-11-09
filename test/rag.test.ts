import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { chunkText, createAI, createApp, createDb, InferloError, memory, mockProvider, model, rag, route, t, type Db, type Usage } from "../src/index.ts";
import { readJson } from "../src/testing.ts";

// rag(table, { ai }): chunk, embed and store documents, then search them by meaning in one call each.

const Chunk = model("rag_chunks", { documentId: t.string().max(40), ownerId: t.string().max(40), text: t.text(), embedding: t.vector(8).index() });
const chunksOf = (db: unknown) => (db as Db<readonly [typeof Chunk]>).rag_chunks;
const words = (n: number, word = "lorem") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");

describe("chunkText", () => {
  test("keeps paragraphs together when they fit, and never exceeds maxChars", () => {
    const text = `First paragraph is short.\n\nSecond paragraph is short too.\n\n${words(80)}`;
    const chunks = chunkText(text, { maxChars: 200, overlap: 0 });
    // Chunks are filled greedily: the next paragraph's words join the first chunk while they fit.
    assert.ok(chunks[0]!.startsWith("First paragraph is short.\n\nSecond paragraph is short too.\n\nlorem0 "));
    for (const c of chunks) assert.ok(c.length <= 200, `${c.length} > 200`);
    assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  });

  test("splits long paragraphs by sentences, then by words, and cuts words longer than a chunk", () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} says something.`).join(" ");
    const chunks = chunkText(sentences, { maxChars: 120, overlap: 0 });
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(c.length <= 120);
      assert.match(c, /^Sentence number \d+ says something\./);
      assert.match(c, /something\.$/);
    }
    const long = chunkText("x".repeat(250), { maxChars: 100, overlap: 0 });
    assert.deepEqual(long.map((c) => c.length), [100, 100, 50]);
  });

  test("overlap repeats the end of the previous chunk from a word boundary, within maxChars", () => {
    const chunks = chunkText(words(200), { maxChars: 300, overlap: 60 });
    assert.ok(chunks.length > 2);
    for (const [i, c] of chunks.entries()) {
      assert.ok(c.length <= 300, `${c.length} > 300`);
      if (i === 0) continue;
      const firstWord = c.split(" ")[0]!;
      assert.ok(chunks[i - 1]!.includes(firstWord), "starts with a word of the previous chunk");
      assert.match(firstWord, /^lorem\d+$/);
    }
    assert.deepEqual(chunkText(""), []);
    assert.deepEqual(chunkText("  \n\n "), []);
    assert.deepEqual(chunkText("Short."), ["Short."]);
  });

  test("invalid options raise IL5038", () => {
    for (const options of [{ maxChars: 10 }, { maxChars: 1.5 }, { maxChars: 100, overlap: 60 }, { overlap: -1 }]) {
      assert.throws(() => chunkText("text", options), (e: InferloError) => e.code === "IL5038");
    }
    assert.throws(() => chunkText(null as never), (e: InferloError) => e.code === "IL5038");
  });
});

describe("rag()", () => {
  const setup = () => {
    const usage: Usage[] = [];
    const provider = mockProvider({ respond: () => "" });
    const ai = createAI({ providers: { mock: provider }, models: { embed: "mock:e" }, onUsage: (u) => void usage.push(u) });
    const db = createDb([Chunk], memory());
    return { ai, db, usage };
  };

  test("add() chunks, embeds in one call and stores a row per chunk; search() returns the closest chunks", async () => {
    const { ai, db, usage } = setup();
    const docs = rag(db.rag_chunks, { ai, model: "embed", chunk: { maxChars: 100, overlap: 0 } });
    const text = "Invoices are due in 30 days.\n\nRefunds take five business days.\n\nSupport is open on weekdays from nine to five.";
    const rows = await docs.add({ text, fields: { documentId: "d1", ownerId: "ann" }, for: "ann" });
    assert.equal(rows.length, 2);
    assert.equal(usage.length, 1, "one embedding call for every chunk");
    assert.equal(usage[0]!.kind, "embed");
    assert.equal(usage[0]!.for, "ann");
    assert.equal(rows[0]!.documentId, "d1");
    assert.equal(rows[0]!.embedding.length, 8);
    await docs.add({ text: "Refunds take five business days.", fields: { documentId: "d2", ownerId: "ben" } });

    const hits = await docs.search({ query: "Support is open on weekdays from nine to five.", where: { ownerId: "ann" }, limit: 3, for: "ann" });
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.text, "Support is open on weekdays from nine to five.");
    assert.ok(Math.abs(hits[0]!.distance) < 1e-9);
    assert.ok(hits[1]!.distance >= hits[0]!.distance);
    assert.equal(hits[0]!.row.documentId, "d1");
    assert.equal(usage.at(-1)!.for, "ann");
    const close = await docs.search({ query: "Support is open on weekdays from nine to five.", maxDistance: 0.000001 });
    assert.deepEqual(close.map((h) => h.text), ["Support is open on weekdays from nine to five."]);
    assert.deepEqual(await docs.add({ text: "   ", fields: { documentId: "d3", ownerId: "ann" } }), []);
  });

  test("invalid tables, options and fields raise IL5038; invalid rows store nothing", async () => {
    const { ai, db } = setup();
    const code = (e: InferloError) => e.code === "IL5038";
    const NoVector = model("rag_plain", { text: t.text() });
    const NoText = model("rag_notext", { body: t.text(), embedding: t.vector(8) });
    const plain = createDb([NoVector, NoText], memory());
    assert.throws(() => rag(plain.rag_plain, { ai }), code);
    assert.throws(() => rag(plain.rag_notext, { ai }), code);
    assert.doesNotThrow(() => rag(plain.rag_notext, { ai, textField: "body" }));
    assert.throws(() => rag({} as never, { ai }), code);
    assert.throws(() => rag(db.rag_chunks, {} as never), code);
    assert.throws(() => rag(db.rag_chunks, { ai, chunk: { maxChars: 5 } }), code);
    const docs = rag(db.rag_chunks, { ai, model: "embed" });
    await assert.rejects(docs.add({ text: "Hi", fields: { documentId: "d", ownerId: "a", text: "x" } as never }), code);
    await assert.rejects(docs.add({ text: 5 } as never), code);
    await assert.rejects(docs.add({ text: "Hello there.", fields: { documentId: "d" } }), (e: InferloError) => e.code === "IL1001");
    assert.equal(await db.rag_chunks.count(), 0);
    await assert.rejects(docs.search({ query: " " }), code);
    await assert.rejects(docs.search({ query: "q", limit: 0 }), code);
    await assert.rejects(docs.search({ query: "q", maxDistance: 3 }), code);
    const small = rag(db.rag_chunks, { ai, model: "embed", chunk: { maxChars: 50, overlap: 0 } });
    await assert.rejects(small.add({ text: words(30000), fields: { documentId: "d", ownerId: "a" } }), (e: InferloError) => code(e) && /at most 1000/.test(e.message));
  });

  test("in a route, with ctx.ai and ctx.db, answers from the user's own documents", async () => {
    const add = route.post("/docs", { body: t.object({ id: t.string().max(40), text: t.text().max(100_000) }) }).handle(async ({ body, ai, db, user, status }) => {
      const rows = await rag(chunksOf(db), { ai, model: "embed" }).add({ text: body.text, fields: { documentId: body.id, ownerId: user.id }, for: user.id });
      status(201);
      return { chunks: rows.length };
    });
    const ask = route.post("/ask", { body: t.object({ question: t.string().max(500) }) }).handle(async ({ body, ai, db, user }) => {
      const hits = await rag(chunksOf(db), { ai, model: "embed" }).search({ query: body.question, where: { ownerId: user.id }, for: user.id });
      const { text } = await ai.generate({ model: "fast", system: `Answer from:\n\n${hits.map((h) => h.text).join("\n\n---\n\n")}`, prompt: body.question, for: user.id });
      return { answer: text, sources: hits.map((h) => h.row.documentId) };
    });
    const answerer = mockProvider({ respond: (r) => (r.messages[0]!.content.includes("Refunds take five business days.") ? "Five business days." : "I do not know.") });
    const app = createApp({
      models: [Chunk],
      routes: [{ add, ask }],
      db: memory(),
      auth: { resolve: () => null },
      ai: { providers: { mock: mockProvider({ respond: () => "" }), answer: answerer }, models: { embed: "mock:e", fast: "answer:a" } },
      logger: { info() {}, error() {} },
    });
    const ann = { id: "ann", roles: [] };
    assert.deepEqual(await readJson(await app.request("/docs", { method: "POST", json: { id: "faq", text: "Refunds take five business days." }, as: ann }), 201), { chunks: 1 });
    const out = await readJson(await app.request("/ask", { method: "POST", json: { question: "Refunds take five business days." }, as: ann }), 200);
    assert.deepEqual(out, { answer: "Five business days.", sources: ["faq"] });
    const other = await readJson(await app.request("/ask", { method: "POST", json: { question: "Refunds take five business days." }, as: { id: "ben", roles: [] } }), 200);
    assert.deepEqual(other, { answer: "I do not know.", sources: [] });
  });
});
