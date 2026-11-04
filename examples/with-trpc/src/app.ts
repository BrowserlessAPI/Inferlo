// An existing tRPC app that adopts Inferlo step by step:
// 1. ctx.ai in procedures, from the inferloAI() middleware, with Inferlo schemas as inputs.
// 2. Streaming model output from a subscription.
// 3. The app's own procedures as tools a model can call for the signed-in user, with trpcTools().
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { anthropic, createAI, env, t, type AI, type AIConfig } from "../../../src/ai/public.ts";
import { inferloAI, trpcTools } from "../../../src/trpc.ts";

export const aiConfig: AIConfig = {
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY", { default: "" }) }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
};

export type Context = { user: { id: string } | null };

const users = new Map([["demo-token", { id: "00000000-0000-4000-8000-000000000001" }]]);

export function createContext({ req }: { req: Request }): Context {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  return { user: (token && users.get(token)) || null };
}

const trpc = initTRPC.context<Context>().create();

const signedIn = trpc.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first." });
  return next({ ctx: { user: ctx.user } });
});

const Label = t.object({ label: t.enum(["bug", "feature", "question"]) });

export function makeRouter(ai: AI = createAI(aiConfig)) {
  const tickets: { id: string; title: string; ownerId: string }[] = [];

  // Procedures the assistant may call as tools.
  const ticketsRouter = trpc.router({
    create: signedIn.input(t.object({ title: t.string().min(1).max(200).describe("Short summary of the problem") })).mutation(({ ctx, input }) => {
      const ticket = { id: `T-${tickets.length + 1}`, title: input.title, ownerId: ctx.user.id };
      tickets.push(ticket);
      return ticket;
    }),
    list: signedIn.query(({ ctx }) => tickets.filter((ticket) => ticket.ownerId === ctx.user.id)),
  });
  const toolRouter = trpc.router({ tickets: ticketsRouter });

  const aiProcedure = signedIn.use(inferloAI(ai));

  return trpc.router({
    tickets: ticketsRouter,

    // Structured output with an Inferlo schema as both the tRPC input and the model's output.
    classify: aiProcedure.input(t.object({ text: t.string().min(1).max(5_000) })).mutation(async ({ ctx, input }) => {
      const { object } = await ctx.ai.generate({ model: "fast", prompt: input.text, output: Label, for: ctx.user.id });
      return object;
    }),

    // Text chunks as the model writes them (httpSubscriptionLink on the client).
    chat: aiProcedure.input(t.object({ prompt: t.string().min(1) })).subscription(async function* ({ ctx, input, signal }) {
      yield* ctx.ai.stream({ model: "fast", prompt: input.prompt, signal, for: ctx.user.id });
    }),

    // The model calls tickets.create and tickets.list as the signed-in user.
    assistant: aiProcedure.input(t.object({ message: t.string().min(1) })).mutation(async ({ ctx, input }) => {
      const tools = trpcTools(toolRouter, {
        caller: toolRouter.createCaller(ctx),
        procedures: {
          "tickets.create": "Open a support ticket for the current user.",
          "tickets.list": "List the current user's tickets.",
        },
      });
      const { text, steps } = await ctx.ai.generate({ model: "fast", prompt: input.message, tools, maxSteps: 5, for: ctx.user.id });
      return { reply: text, toolCalls: steps.flatMap((step) => step.toolCalls.map((call) => call.name)) };
    }),
  });
}

export type AppRouter = ReturnType<typeof makeRouter>;

/** A fetch handler serving the router under /trpc. */
export function makeHandler(ai?: AI) {
  const router = makeRouter(ai);
  return (req: Request) => fetchRequestHandler({ endpoint: "/trpc", req, router, createContext });
}
