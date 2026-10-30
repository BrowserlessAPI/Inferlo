import { notFound, route, t } from "@kairojs/core";
import { Note } from "../models.ts";

const IdParams = t.object({ id: t.uuid() });

export const listNotes = route
  .get("/notes", {
    summary: "List my notes",
    query: t.object({ limit: t.int().min(1).max(100).default(20), offset: t.int().min(0).default(0) }),
    tool: true,
  })
  .handle(({ query, user, db }) =>
    db.notes.findMany({ where: { ownerId: user.id }, orderBy: { createdAt: "desc" }, limit: query.limit, offset: query.offset }),
  );

export const getNote = route
  .get("/notes/:id", { params: IdParams, summary: "Get one note", tool: true })
  .handle(async ({ params, user, db }) => {
    const note = await db.notes.get(params.id);
    if (note.ownerId !== user.id) throw notFound();
    return note;
  });

export const createNote = route
  .post("/notes", { body: Note.pick("title", "body"), summary: "Create a note", tool: true })
  .handle(({ body, user, db, status }) => {
    status(201);
    return db.notes.insert({ ...body, ownerId: user.id });
  });

export const updateNote = route
  .patch("/notes/:id", { params: IdParams, body: Note.pick("title", "body").partial(), summary: "Update a note" })
  .handle(async ({ params, body, user, db }) => {
    const note = await db.notes.get(params.id);
    if (note.ownerId !== user.id) throw notFound();
    return db.notes.update(note.id, body);
  });

export const deleteNote = route
  .delete("/notes/:id", { params: IdParams, summary: "Delete a note" })
  .handle(async ({ params, user, db }) => {
    const note = await db.notes.get(params.id);
    if (note.ownerId !== user.id) throw notFound();
    await db.notes.delete(note.id);
  });

const Summary = t.object({ summary: t.string().max(300).describe("One or two sentences") });

export const summarizeNote = route
  .post("/notes/:id/summary", { params: IdParams, summary: "Summarize a note with AI" })
  .handle(async ({ params, user, db, ai }) => {
    const note = await db.notes.get(params.id);
    if (note.ownerId !== user.id) throw notFound();
    const { object } = await ai.generate({ model: "fast", prompt: `Summarize:\n\n${note.title}\n\n${note.body}`, output: Summary, for: user.id });
    return object;
  });
