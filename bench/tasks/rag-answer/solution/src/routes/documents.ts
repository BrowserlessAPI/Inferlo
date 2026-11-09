import { rag, route, t } from "@browserlessapi/inferlo";

export const addDocument = route
  .post("/documents", { body: t.object({ text: t.text().min(1).max(200_000) }), summary: "Store a document to answer questions from", rateLimit: { max: 20, per: "hour" } })
  .handle(async ({ body, ai, db, user, status }) => {
    const documentId = crypto.randomUUID();
    const rows = await rag(db.doc_chunks, { ai, model: "embed" }).add({ text: body.text, fields: { documentId, ownerId: user.id }, for: user.id });
    status(201);
    return { documentId, chunks: rows.length };
  });

export const ask = route
  .post("/ask", { body: t.object({ question: t.string().min(1).max(2000) }), summary: "Answer a question from my documents", rateLimit: { max: 30, per: "minute" } })
  .handle(async ({ body, ai, db, user }) => {
    const hits = await rag(db.doc_chunks, { ai, model: "embed" }).search({ query: body.question, where: { ownerId: user.id }, limit: 5, for: user.id });
    const { text } = await ai.generate({
      model: "fast",
      system: `Answer only from these excerpts.\n\n${hits.map((h) => h.text).join("\n\n---\n\n")}`,
      prompt: body.question,
      for: user.id,
    });
    return { answer: text, sources: [...new Set(hits.map((h) => h.row.documentId))] };
  });
