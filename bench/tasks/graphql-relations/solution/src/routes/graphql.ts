import { graphqlRoute } from "@browserlessapi/inferlo/graphql";
import { Note } from "../models.ts";
import { createNote, getNote, listNotes } from "./notes.ts";
import { usersByIds } from "./users.ts";

// Each field runs its route as the caller, with the route's auth, validation and rate limits.
export const graphql = graphqlRoute({
  query: { notes: listNotes, note: getNote },
  mutation: { createNote },
  relations: [{ model: Note, field: "owner", route: usersByIds, from: "ownerId" }],
  introspection: false,
});
