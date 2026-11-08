import { createYoga } from "graphql-yoga";
import { graphqlContext, graphqlSchema } from "@browserlessapi/inferlo/graphql";
import { app } from "./app.ts";
import { createNote, getNote, listNotes } from "./routes/notes.ts";

export const yoga = createYoga({
  schema: graphqlSchema({ query: { notes: listNotes, note: getNote }, mutation: { createNote } }),
  context: ({ request }) => graphqlContext(app, request),
});
