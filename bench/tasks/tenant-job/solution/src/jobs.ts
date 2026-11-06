import { job, t } from "@browserlessapi/inferlo";

// Queued from a request, the job gets the request's tenant: db.projects is scoped to that organisation.
export const renameProjectJob = job("rename-project", { input: t.object({ projectId: t.uuid(), name: t.string().min(1).max(100) }) }).handle(
  async ({ input, db }) => {
    await db.projects.update(input.projectId, { name: input.name });
  },
);
