import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createDb, InferloError, memory, model, t, type Adapter, type Row } from "../src/index.ts";
import { postgres } from "../src/db/postgres.ts";

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
const models = [User, Team, Ticket] as const;

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

for (const [name, make] of adapters) {
  describe(`relations (${name})`, () => {
    const adapter = counting(make());
    const db = createDb(models, adapter);

    before(async () => {
      if (name === "postgres") await db.$sql('DROP TABLE IF EXISTS "rel_tickets", "rel_teams", "rel_users" CASCADE');
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
      await assert.rejects(db.rel_users.findMany({ include: { owner: true } as never }), (e: unknown) => e instanceof InferloError && e.code === "IL4023" && /no t.ref fields/.test(e.fix ?? ""));
    });
  });
}
