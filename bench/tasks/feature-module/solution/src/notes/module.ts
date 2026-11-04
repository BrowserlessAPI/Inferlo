import { module } from "@browserlessapi/inferlo";
import { noteModels } from "../models.ts";
import * as noteRoutes from "../routes/notes.ts";

export const notes = module("notes", {
  description: "Personal notes with AI summaries.",
  models: noteModels,
  routes: [noteRoutes],
});
