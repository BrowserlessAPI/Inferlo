import { notFound, route, t } from "../../../../src/index.ts";
import { Ticket } from "../models.ts";
import { access } from "../permissions.ts";

export const listTickets = route
  .get("/tickets", {
    summary: "List my tickets",
    query: t.object({
      status: t.enum(["open", "closed"]).optional(),
      limit: t.int().min(1).max(100).default(20),
    }),
    tool: true,
  })
  .handle(({ query, user, db }) =>
    db.tickets.findMany({
      where: { ownerId: user.id, status: query.status },
      orderBy: { createdAt: "desc" },
      limit: query.limit,
    }),
  );

export const createTicket = route
  .post("/tickets", {
    summary: "Open a support ticket",
    body: Ticket.pick("title", "body", "priority"),
    tool: true,
  })
  .handle(async ({ body, user, db, status }) => {
    status(201);
    return db.tickets.insert({ ...body, ownerId: user.id });
  });

export const getTicket = route
  .get("/tickets/:id", { params: t.object({ id: t.uuid() }), summary: "Get one ticket", tool: true })
  .handle(async ({ params, user, db }) => {
    const ticket = await db.tickets.get(params.id);
    if (!(await access.can("tickets.view", { user, ticket }))) throw notFound(`Ticket ${params.id} was not found.`);
    return ticket;
  });

export const closeTicket = route
  .post("/tickets/:id/close", { params: t.object({ id: t.uuid() }), permission: "tickets.close", summary: "Close a ticket (agents only)", tool: true })
  .handle(({ params, db }) => db.tickets.update(params.id, { status: "closed" }));

const Triage = t.object({
  priority: Ticket.fields.priority,
  summary: t.string().max(500).describe("One sentence for the support agent"),
});

export const triageTicket = route
  .post("/tickets/:id/triage", { params: t.object({ id: t.uuid() }), permission: "tickets.triage", summary: "AI triage: set priority and summary" })
  .handle(async ({ params, db, ai, user }) => {
    const ticket = await db.tickets.get(params.id);
    const { object } = await ai.generate({
      model: "fast",
      system: "You triage customer support tickets.",
      prompt: `Title: ${ticket.title}\n\n${ticket.body}`,
      output: Triage,
      for: user.id,
    });
    return db.tickets.update(ticket.id, object);
  });

export const health = route.get("/health", { auth: "public" }).handle(() => ({ ok: true }));
