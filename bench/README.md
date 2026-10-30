# AI success benchmark

Measures how often an AI model completes real backend tasks in Kairo correctly on the first try.

Each task in `tasks/<id>/` has:

- `task.json`: the instruction given to the model
- `setup/` (optional): files that change the starting project, e.g. to plant a bug
- `check.test.ts`: the hidden test that decides pass or fail
- `solution/`: a reference solution, used to prove the task is solvable

The starting project is exactly what `kairo new` creates. The model receives the task, the project's `AGENTS.md` and every file in `src/`, and returns full file contents. A task passes when the typecheck and `check.test.ts` both pass.

```bash
npm run build
node bench/run.ts --verify      # every reference solution must pass
node bench/run.ts --baseline    # with no changes every task must fail (checks really test something)

KAIRO_BENCH_MODEL=anthropic:claude-sonnet-4-5 ANTHROPIC_API_KEY=... node bench/run.ts
KAIRO_BENCH_MODEL=openai:gpt-5 OPENAI_API_KEY=... node bench/run.ts
KAIRO_BENCH_MODEL=local:qwen3-coder KAIRO_BENCH_BASE_URL=http://127.0.0.1:11434/v1 node bench/run.ts
```

Results are written to `results/`. Only publish numbers produced by this runner.

Planned (see ROADMAP.md): 30 tasks, and the same tasks for Express, Hono and NestJS for a fair comparison.
