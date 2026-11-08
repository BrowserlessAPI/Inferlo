import type { IncomingMessage } from "node:http";
import { ApolloServer } from "@apollo/server";
import { graphqlContext, graphqlSchema, type GraphQLContext } from "@browserlessapi/inferlo/graphql";
import { app } from "./app.ts";
import { createNote, getNote, listNotes } from "./routes/notes.ts";

export const server = new ApolloServer<GraphQLContext>({
  schema: graphqlSchema({ query: { notes: listNotes, note: getNote }, mutation: { createNote } }),
});

export const context = async ({ req }: { req: IncomingMessage }) => graphqlContext(app, req);
