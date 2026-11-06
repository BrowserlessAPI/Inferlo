import { route, t } from "@browserlessapi/inferlo";
import { renameProjectJob } from "../jobs.ts";
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

export const renameProject = route
  .post("/projects/:id/rename", { params: t.object({ id: t.uuid() }), body: Project.pick("name"), summary: "Rename a project in the background" })
  .handle(async ({ params, body, jobs, status }) => {
    // The job runs for the user's organisation: its ctx.db only sees that organisation's projects.
    await jobs.enqueue(renameProjectJob, { projectId: params.id, name: body.name });
    status(202);
    return { queued: true };
  });
