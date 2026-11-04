import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createAI, mockProvider, t, type MockReply, type ProviderRequest } from "../src/ai/public.ts";
import { createApp, InferloError } from "../src/index.ts";
import { inferloAI, trpcTools } from "../src/trpc.ts";

type Context = { user: { id: string; roles: string[] } | null };

function makeAI(respond: (request: ProviderRequest) => MockReply = () => '{"label":"bug"}') {
  const usage: { for?: string; model: string }[] = [];
  const ai = createAI({ providers: { mock: mockProvider({ respond }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) });
  return { ai, usage };
}

const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;

describe("inferloAI() tRPC middleware", () => {
  test("puts ai on the context, typed next to the app's own context, with Inferlo schemas as inputs", async () => {
    const { ai, usage } = makeAI();
    const trpc = initTRPC.context<Context>().create();
    const aiProcedure = trpc.procedure.use(inferloAI(ai));
    const router = trpc.router({
      classify: aiProcedure.input(t.object({ text: t.string().min(1) })).mutation(async ({ ctx, input }) => {
        const { object } = await ctx.ai.generate({ model: "fast", prompt: input.text, output: t.object({ label: t.enum(["bug", "feature"]) }), for: ctx.user?.id });
        return object;
      }),
    });
    const caller = router.createCaller({ user: { id: "user-1", roles: [] } });
    assert.deepEqual(await caller.classify({ text: "It crashes" }), { label: "bug" });
    assert.equal(usage[0]?.for, "user-1");
    // Invalid input is a BAD_REQUEST TRPCError whose cause is Inferlo's ValidationError (IL1001).
    await assert.rejects(caller.classify({ text: "" }), (e: unknown) => e instanceof TRPCError && e.code === "BAD_REQUEST" && e.cause instanceof InferloError && e.cause.code === "IL1001");
  });

  test("streams AI text chunks from a subscription and over HTTP with the fetch adapter", async () => {
    const { ai } = makeAI(() => "Hello from the model");
    const trpc = initTRPC.create();
    const aiProcedure = trpc.procedure.use(inferloAI(ai));
    const router = trpc.router({
      chat: aiProcedure.input(t.object({ prompt: t.string() })).subscription(async function* ({ ctx, input, signal }) {
        yield* ctx.ai.stream({ model: "fast", prompt: input.prompt, signal });
      }),
      ask: aiProcedure.input(t.object({ prompt: t.string() })).query(async ({ ctx, input }) => (await ctx.ai.generate({ model: "fast", prompt: input.prompt })).text),
    });
    let text = "";
    for await (const chunk of await router.createCaller({}).chat({ prompt: "hi" })) text += chunk;
    assert.equal(text, "Hello from the model");

    const res = await fetchRequestHandler({ endpoint: "/trpc", req: new Request(`http://localhost/trpc/ask?input=${encodeURIComponent(JSON.stringify({ prompt: "hi" }))}`), router, createContext: () => ({}) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { result: { data: "Hello from the model" } });
  });

  test("works with an Inferlo app's app.ai", async () => {
    const inferlo = createApp({ ai: { providers: { mock: mockProvider({ respond: () => "pong" }) }, models: { fast: "mock:m" } }, logger: { info() {}, error() {} } });
    const trpc = initTRPC.create();
    const router = trpc.router({ ping: trpc.procedure.use(inferloAI(inferlo.ai)).query(async ({ ctx }) => (await ctx.ai.generate({ model: "fast", prompt: "ping" })).text) });
    assert.equal(await router.createCaller({}).ping(), "pong");
  });

  test("anything that is not an AI client raises IL5014", () => {
    for (const value of [undefined, {}, { generate() {} }, createApp({ logger: { info() {}, error() {} } })]) {
      assert.throws(() => inferloAI(value as never), isCode("IL5014"));
    }
  });
});

describe("trpcTools()", () => {
  function makeRouter() {
    const trpc = initTRPC.context<Context>().create();
    const signedIn = trpc.procedure.use(({ ctx, next }) => {
      if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first." });
      return next({ ctx: { user: ctx.user } });
    });
    const tickets: { id: string; title: string; ownerId: string }[] = [];
    const router = trpc.router({
      tickets: trpc.router({
        create: signedIn.input(t.object({ title: t.string().min(1).describe("Short title") })).mutation(({ ctx, input }) => {
          const ticket = { id: `t${tickets.length + 1}`, title: input.title, ownerId: ctx.user.id };
          tickets.push(ticket);
          return ticket;
        }),
        get: signedIn.input(t.object({ id: t.string() })).query(({ ctx, input }) => {
          const ticket = tickets.find((x) => x.id === input.id);
          if (!ticket) throw new TRPCError({ code: "NOT_FOUND", message: `No ticket ${input.id}.` });
          if (ticket.ownerId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Not your ticket." });
          return ticket;
        }),
        count: signedIn.query(() => tickets.length),
        crash: signedIn.mutation(() => {
          throw new Error("database is down");
        }),
      }),
      watch: trpc.procedure.subscription(async function* () {
        yield 1;
      }),
    });
    return { router, tickets };
  }

  test("tools from procedures run through the caller as the current user, with the input schema the model sees", async () => {
    const { router, tickets } = makeRouter();
    const tools = trpcTools(router, {
      caller: router.createCaller({ user: { id: "alice", roles: [] } }),
      procedures: { "tickets.create": "Create a support ticket.", "tickets.count": "Count tickets." },
    });
    assert.deepEqual(
      tools.map((x) => x.name),
      ["tickets_create", "tickets_count"],
    );
    const seen: ProviderRequest[] = [];
    const { ai } = makeAI((r) => {
      seen.push(r);
      const toolMessages = r.messages.filter((m) => m.role === "tool").length;
      if (toolMessages === 0) return { toolCalls: [{ name: "tickets_create", input: { title: "Printer on fire" } }] };
      if (toolMessages === 1) return { toolCalls: [{ name: "tickets_count", input: {} }] };
      return "Created ticket t1.";
    });
    const result = await ai.generate({ model: "fast", prompt: "File a ticket", tools, maxSteps: 5 });
    assert.equal(result.text, "Created ticket t1.");
    assert.deepEqual(tickets, [{ id: "t1", title: "Printer on fire", ownerId: "alice" }]);
    assert.deepEqual(result.steps[0]!.toolCalls[0]!.output, { id: "t1", title: "Printer on fire", ownerId: "alice" });
    assert.equal(result.steps[1]!.toolCalls[0]!.output, 1);
    const spec = seen[0]!.tools!.find((x) => x.name === "tickets_create")!;
    assert.equal(spec.description, "Create a support ticket.");
    assert.deepEqual((spec.inputSchema as { required: string[] }).required, ["title"]);
    assert.equal((spec.inputSchema as { properties: Record<string, { description?: string }> }).properties.title!.description, "Short title");
  });

  test("TRPCErrors a model can correct and invalid arguments become failed tool results", async () => {
    const { router } = makeRouter();
    await router.createCaller({ user: { id: "bob", roles: [] } }).tickets.create({ title: "Bob's" });
    const tools = trpcTools(router, { caller: router.createCaller({ user: { id: "alice", roles: [] } }), procedures: { "tickets.get": "Get a ticket by id." } });
    const calls = [{ id: "nope" }, { id: "t1" }, { id: 5 }];
    const { ai } = makeAI((r) => {
      const n = r.messages.filter((m) => m.role === "tool").length;
      return n < calls.length ? { toolCalls: [{ name: "tickets_get", input: calls[n]! }] } : "Done";
    });
    const result = await ai.generate({ model: "fast", prompt: "Get tickets", tools, maxSteps: 5 });
    const [notFound, forbidden, invalid] = result.steps.map((s) => s.toolCalls[0]!);
    assert.equal(notFound!.status, 404);
    assert.equal(notFound!.isError, true);
    const error = (output: unknown) => (output as { error: { code: string; message: string } }).error;
    assert.equal(error(notFound!.output).code, "NOT_FOUND");
    assert.equal(error(notFound!.output).message, "No ticket nope.");
    assert.equal(forbidden!.status, 403);
    assert.equal(invalid!.status, 422);
    assert.equal(error(invalid!.output).code, "IL1001");
  });

  test("a caller without a user gets UNAUTHORIZED back as a failed tool result, and server errors reject ai.generate", async () => {
    const { router } = makeRouter();
    const tools = trpcTools(router, { caller: router.createCaller({ user: null }), procedures: { "tickets.count": "Count tickets.", "tickets.crash": "Crash." } });
    const { ai } = makeAI((r) => (r.messages.some((m) => m.role === "tool") ? "Done" : { toolCalls: [{ name: "tickets_count", input: {} }] }));
    const result = await ai.generate({ model: "fast", prompt: "Count", tools, maxSteps: 3 });
    assert.equal(result.steps[0]!.toolCalls[0]!.status, 401);

    const signedIn = trpcTools(router, { caller: router.createCaller({ user: { id: "alice", roles: [] } }), procedures: { "tickets.crash": "Crash." } });
    const crashing = makeAI(() => ({ toolCalls: [{ name: "tickets_crash", input: {} }] })).ai;
    await assert.rejects(crashing.generate({ model: "fast", prompt: "Crash", tools: signedIn, maxSteps: 3 }), (e: unknown) => e instanceof TRPCError && e.code === "INTERNAL_SERVER_ERROR");
  });

  test("procedures with other inputs take an explicit t.object input", async () => {
    const trpc = initTRPC.create();
    const shout = trpc.procedure.input((value: unknown) => value as { text: string }).query(({ input }) => input.text.toUpperCase());
    const router = trpc.router({ shout });
    assert.throws(() => trpcTools(router, { caller: router.createCaller({}), procedures: { shout: "Shout." } }), isCode("IL5017"));
    const [tool] = trpcTools(router, { caller: router.createCaller({}), procedures: { shout: { description: "Shout the text.", input: t.object({ text: t.string() }) } } });
    const { ai } = makeAI((r) => (r.messages.some((m) => m.role === "tool") ? "Done" : { toolCalls: [{ name: "shout", input: { text: "hi" } }] }));
    const result = await ai.generate({ model: "fast", prompt: "Shout", tools: [tool!], maxSteps: 3 });
    assert.equal(result.steps[0]!.toolCalls[0]!.output, "HI");
  });

  test("invalid options raise IL5017 naming every problem", () => {
    const { router } = makeRouter();
    const caller = router.createCaller({ user: null });
    const cases: [unknown, unknown, RegExp][] = [
      [{}, { caller, procedures: { a: "A" } }, /tRPC router/],
      [router, undefined, /options must be/],
      [router, { procedures: { "tickets.get": "Get." } }, /caller must be/],
      [router, { caller, procedures: {} }, /at least one procedure/],
      [router, { caller, procedures: { "tickets.delete": "Delete." } }, /"tickets\.delete" is not a procedure of this router \(procedures: tickets\.create, tickets\.get/],
      [router, { caller, procedures: { watch: "Watch." } }, /subscription procedure; only queries and mutations/],
      [router, { caller, procedures: { "tickets.get": "  " } }, /needs a description/],
      [router, { caller, procedures: { "tickets.get": { description: "Get.", input: t.string() } } }, /input must be a t\.object/],
    ];
    for (const [r, options, message] of cases) {
      assert.throws(
        () => trpcTools(r as object, options as never),
        (e: unknown) => isCode("IL5017")(e) && message.test((e as Error).message),
        String(message),
      );
    }
  });
});
