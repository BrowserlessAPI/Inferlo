// The existing app's MikroORM entities, defined with defineEntity (no decorators).
import { defineEntity, p } from "@mikro-orm/postgresql";

export const Project = defineEntity({
  name: "Project",
  tableName: "pm_projects",
  properties: {
    id: p.integer().primary(),
    name: p.string().length(200),
    tasks: () => p.oneToMany(Task).mappedBy("project"),
  },
});

export const Task = defineEntity({
  name: "Task",
  tableName: "pm_tasks",
  properties: {
    id: p.integer().primary(),
    key: p.string().length(40).unique(),
    title: p.string().length(200),
    project: () => p.manyToOne(Project),
  },
});
