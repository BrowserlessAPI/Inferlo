import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createDb, InferloError, memory, model, t, type Adapter, type Row } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";
import { postgresJsAdapter } from "./postgres-js-adapter.ts";

const PG_URL = process.env.INFERLO_TEST_DATABASE_URL;

const User = model("rel_users", { name: t.string().max(80) });
const Team = model("rel_teams", { title: t.string().max(80) });
const Ticket = model("rel_tickets", {
  title: t.string().max(200),
  ownerId: t.ref("rel_users", { onDelete: "cascade" }),
  assigneeId: t.ref("rel_users", { onDelete: "set null" }).nullable().optional(),
  teamId: t.ref("rel_teams").optional(),
  // Not a relation: the name does not end in Id.
  parent: t.ref("rel_tickets").optional(),
});
// No relations either way.
const Note = model("rel_notes", { body: t.text() });
const models = [User, Team, Ticket, Note] as const;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>() => void 0 as unknown as T;

/** Counts select queries, to prove there is one query per relation and no N+1. */
function counting(adapter: Adapter): Adapter & { selects: string[] } {
  const selects: string[] = [];
  return Object.assign(Object.create(adapter) as Adapter, {
    selects,
    select: (m: Parameters<Adapter["select"]>[0], q: Parameters<Adapter["select"]>[1]) => {
      selects.push(m.name);
      return adapter.select(m, q);
    },
  });
}

const adapters: [string, () => Adapter][] = [["memory", () => memory()]];
if (PG_URL) adapters.push(["postgres", () => postgres({ url: PG_URL })]);
if (PG_URL) adapters.push(["postgres.js", () => postgresJsAdapter(PG_URL)]);

for (const [name, make] of adapters) {
  describe(`relations (${name})`, () => {
    const adapter = counting(make());
    const db = createDb(models, adapter);

    before(async () => {
      if (name !== "memory") await db.$sql('DROP TABLE IF EXISTS "rel_tickets", "rel_teams", "rel_users", "rel_notes" CASCADE');
      await db.$sync();
    });
    after(async () => {
      await db.$close();
    });

    test("findMany include loads each relation with one extra query, typed", async () => {
      const ann = await db.rel_users.insert({ name: "Ann" });
      const ben = await db.rel_users.insert({ name: "Ben" });
      const team = await db.rel_teams.insert({ title: "Support" });
      const created = [];
      for (let i = 0; i < 6; i++) {
        created.push(await db.rel_tickets.insert({ title: `T${i}`, ownerId: i % 2 ? ann.id : ben.id, assigneeId: i === 0 ? ann.id : null, teamId: i < 3 ? team.id : undefined }));
      }
      adapter.selects.length = 0;
      const tickets = await db.rel_tickets.findMany({ include: { owner: true, assignee: true, team: true }, orderBy: { title: "asc" } });
      assert.deepEqual(adapter.selects, ["rel_tickets", "rel_users", "rel_users", "rel_teams"]);
      assert.equal(tickets.length, 6);
      assert.equal(tickets[0]!.owner.name, "Ben");
      assert.equal(tickets[1]!.owner.name, "Ann");
      assert.equal(tickets[0]!.assignee?.name, "Ann");
      assert.equal(tickets[1]!.assignee, null);
      assert.equal(tickets[2]!.team?.title, "Support");
      assert.equal(tickets[5]!.team, null);
      assert.ok(tickets[0]!.owner.createdAt instanceof Date);
      assert.equal(tickets[0]!.ownerId, ben.id);

      type T = (typeof tickets)[number];
      assertType<Equal<T["owner"], Row<typeof User>>>();
      assertType<Equal<T["assignee"], Row<typeof User> | null>>();
      assertType<Equal<T["team"], Row<typeof Team> | null>>();

      // Without include, rows are unchanged.
      const plain = await db.rel_tickets.findMany({ where: { id: created[0]!.id } });
      assert.equal("owner" in plain[0]!, false);
      // @ts-expect-error owner is only there with include
      void plain[0]!.owner;
    });

    test("get, find and findOne take include too, and false or undefined skips a relation", async () => {
      const ann = await db.rel_users.insert({ name: "Ann2" });
      const ticket = await db.rel_tickets.insert({ title: "One", ownerId: ann.id });
      adapter.selects.length = 0;
      const got = await db.rel_tickets.get(ticket.id, { include: { owner: true, team: false } });
      assert.equal(got.owner.name, "Ann2");
      assert.equal("team" in got, false);
      assert.deepEqual(adapter.selects, ["rel_tickets", "rel_users"]);
      assert.equal((await db.rel_tickets.find(ticket.id, { include: { owner: true } }))?.owner.name, "Ann2");
      assert.equal((await db.rel_tickets.findOne({ title: "One" }, { include: { owner: true } }))?.owner.id, ann.id);
      assert.equal(await db.rel_tickets.find(crypto.randomUUID(), { include: { owner: true } }), null);
      // No rows: no relation query.
      adapter.selects.length = 0;
      assert.deepEqual(await db.rel_tickets.findMany({ where: { title: "none" }, include: { owner: true } }), []);
      assert.deepEqual(adapter.selects, ["rel_tickets"]);
    });

    test("unknown relations raise IL4023 with the available names", async () => {
      await assert.rejects(
        // @ts-expect-error not a relation
        db.rel_tickets.findMany({ include: { ownr: true } }),
        (e: unknown) => e instanceof InferloError && e.code === "IL4023" && /Did you mean "owner"/.test(e.message) && /owner \(ownerId\), assignee \(assigneeId\), team \(teamId\)/.test(e.fix ?? ""),
      );
      await assert.rejects(
        // @ts-expect-error parent does not end in Id, so it is not a relation
        db.rel_tickets.findMany({ include: { parent: true } }),
        (e: unknown) => e instanceof InferloError && e.code === "IL4023",
      );
      await assert.rejects(db.rel_teams.findMany({ include: { owner: true } as never }), (e: unknown) => e instanceof InferloError && e.code === "IL4023" && /rel_tickets \(rel_tickets.teamId\)/.test(e.fix ?? ""));
      await assert.rejects(db.rel_notes.findMany({ include: { owner: true } as never }), (e: unknown) => e instanceof InferloError && e.code === "IL4023" && /has no relations/.test(e.fix ?? ""));
    });

    test("reverse relations: include the rows that reference this one, one query per relation, typed", async () => {
      const team = await db.rel_teams.insert({ title: "Rev" });
      const empty = await db.rel_teams.insert({ title: "Empty" });
      const other = await db.rel_teams.insert({ title: "Other" });
      const ann = await db.rel_users.insert({ name: "RevAnn" });
      const a = await db.rel_tickets.insert({ title: "R1", ownerId: ann.id, teamId: team.id });
      const b = await db.rel_tickets.insert({ title: "R2", ownerId: ann.id, teamId: team.id });
      await db.rel_tickets.insert({ title: "R3", ownerId: ann.id, teamId: other.id });
      adapter.selects.length = 0;
      const teams = await db.rel_teams.findMany({ where: { id: { in: [team.id, empty.id] } }, orderBy: { title: "desc" }, include: { rel_tickets: true } });
      assert.deepEqual(adapter.selects, ["rel_teams", "rel_tickets"]);
      assert.equal(teams[0]!.title, "Rev");
      assert.deepEqual(teams[0]!.rel_tickets.map((x) => x.id).sort(), [a.id, b.id].sort());
      assert.ok(teams[0]!.rel_tickets[0]!.createdAt instanceof Date);
      assert.deepEqual(teams[1]!.rel_tickets, []);
      type T = (typeof teams)[number];
      assertType<Equal<T["rel_tickets"], Row<typeof Ticket>[]>>();

      // get, find and findOne too.
      const got = await db.rel_teams.get(other.id, { include: { rel_tickets: true } });
      assert.equal(got.rel_tickets.length, 1);
      assert.equal(got.rel_tickets[0]!.title, "R3");
      assert.equal((await db.rel_teams.findOne({ title: "Empty" }, { include: { rel_tickets: true } }))?.rel_tickets.length, 0);
    });

    test("several refs to the same model are named <table>By<Name>, and the plain table name is ambiguous", async () => {
      const ann = await db.rel_users.insert({ name: "Multi" });
      const ben = await db.rel_users.insert({ name: "Multi2" });
      await db.rel_tickets.insert({ title: "M1", ownerId: ann.id, assigneeId: ben.id });
      await db.rel_tickets.insert({ title: "M2", ownerId: ann.id });
      adapter.selects.length = 0;
      const users = await db.rel_users.findMany({ where: { name: { like: "Multi%" } }, orderBy: { name: "asc" }, include: { rel_ticketsByOwner: true, rel_ticketsByAssignee: true } });
      assert.deepEqual(adapter.selects, ["rel_users", "rel_tickets", "rel_tickets"]);
      assert.deepEqual(users[0]!.rel_ticketsByOwner.map((x) => x.title).sort(), ["M1", "M2"]);
      assert.deepEqual(users[0]!.rel_ticketsByAssignee, []);
      assert.deepEqual(users[1]!.rel_ticketsByAssignee.map((x) => x.title), ["M1"]);
      assertType<Equal<(typeof users)[number]["rel_ticketsByOwner"], Row<typeof Ticket>[]>>();
      await assert.rejects(
        // @ts-expect-error ambiguous: rel_tickets has ownerId and assigneeId
        db.rel_users.findMany({ include: { rel_tickets: true } }),
        (e: unknown) => e instanceof InferloError && e.code === "IL4023" && /ambiguous/.test(e.message) && /rel_ticketsByOwner \(rel_tickets.ownerId\), rel_ticketsByAssignee \(rel_tickets.assigneeId\)/.test(e.fix ?? ""),
      );
      // Forward and reverse together, and a self reference (rel_tickets.parent is not a relation, so no reverse).
      const tickets = await db.rel_tickets.findMany({ where: { title: "M1" }, include: { owner: true } });
      assert.equal(tickets[0]!.owner.name, "Multi");
    });
  });
}
