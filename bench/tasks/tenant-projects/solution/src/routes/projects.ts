import { route } from "@browserlessapi/inferlo";
import { Project } from "../models.ts";

export const listProjects = route
  .get("/projects", { summary: "List my organisation's projects" })
  .handle(({ db }) => db.projects.findMany({ orderBy: { createdAt: "asc" } }));

export const createProject = route
  .post("/projects", { body: Project.pick("name"), summary: "Create a project" })
  .handle(({ body, db, status }) => {
    status(201);
    return db.projects.insert(body);
  });
