import { initTRPC } from "@trpc/server";
import { anthropic, createAI, env, t } from "@browserlessapi/inferlo/ai";
import { inferloAI, trpcTools } from "@browserlessapi/inferlo/trpc";

export const notes: string[] = [];

const ai = createAI({
  providers: { anthropic: anthropic({ apiKey: env("ANTHROPIC_API_KEY") }) },
  models: { fast: "anthropic:claude-haiku-4-5" },
});

const trpc = initTRPC.create();
const aiProcedure = trpc.procedure.use(inferloAI(ai));

const notesRouter = trpc.router({
  add: trpc.procedure.input(t.object({ text: t.string().min(1) })).mutation(({ input }) => {
    notes.push(input.text);
    return { count: notes.length };
  }),
});
const toolRouter = trpc.router({ notes: notesRouter });

export const appRouter = trpc.router({
  notes: notesRouter,
  assistant: aiProcedure.input(t.object({ message: t.string() })).mutation(async ({ ctx, input }) => {
    const tools = trpcTools(toolRouter, {
      caller: toolRouter.createCaller(ctx),
      procedures: { "notes.add": "Save a note with the given text." },
    });
    const { text } = await ctx.ai.generate({ model: "fast", prompt: input.message, tools, maxSteps: 5 });
    return { reply: text };
  }),
});
