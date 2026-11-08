import { graphqlRoute } from "@browserlessapi/inferlo/graphql";
import { createNote, getNote, listNotes } from "./notes.ts";

// Each field runs its route as the caller, with the route's auth, validation and rate limits.
export const graphql = graphqlRoute({
  query: { notes: listNotes, note: getNote },
  mutation: { createNote },
  introspection: false,
});
