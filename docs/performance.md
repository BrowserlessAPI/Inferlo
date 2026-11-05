# Performance

Inferlo publishes a reproducible throughput and latency benchmark against Fastify, Hono, Express and NestJS. It lives in `bench/perf/` and runs with one command:

```bash
npm ci
npm run bench:perf                                    # every framework, 10 s per route after a 3 s warm-up
node bench/perf/run.ts --only inferlo,fastify --duration 5 --connections 100
node bench/perf/run.ts --json                         # machine-readable results
```

## What is measured

Every framework serves the same two routes from its own Node.js process (`bench/perf/servers/<framework>.ts`):

| Route | Request | Answer |
|---|---|---|
| `GET /hello` | none | `{"hello":"world"}` |
| `POST /echo` | `{"name":"Ada","count":3}` | the body, after checking `name` (1 to 100 characters) and `count` (a whole number from 0 to 1000); an invalid body gets a 4xx |

- Inferlo runs with its defaults, as an app in production would: request ids, secure response headers, schema validation, the request timeout and the error handler are on; request logging and OpenAPI are off. It is served by `app.listen()`.
- Fastify validates the body with its built-in JSON schema support. Hono runs on `@hono/node-server`. Express uses `express.json()`. NestJS uses its default Express platform. Hono, Express and NestJS check the body with the same hand-written function, because they have no built-in validation.
- Before a framework is measured, the runner checks that it answers each route correctly and rejects an invalid body (the test `test/perf-servers.test.ts` does the same in CI), so a broken server cannot look fast.
- The load comes from [autocannon](https://github.com/mcollina/autocannon) in the runner's process: 50 connections, no pipelining, a warm-up run, then the measured run, one framework at a time. It reports the average requests per second and the 99th percentile latency.

## Results

Measured on 2026-11-05 with Inferlo 0.6.0 (Fastify 5.12, Hono 4.13, Express 5.3, NestJS 12.3), Node.js 22.23.4 on Linux x64, Intel Xeon @ 2.10GHz with 2 CPUs; 50 connections, 10 s per route after a 3 s warm-up. The load generator shares the 2 CPUs with the server, so the fastest frameworks are partly limited by it.

| Framework | `GET /hello` req/s | p99 ms | `POST /echo` req/s | p99 ms |
|---|---:|---:|---:|---:|
| Inferlo | 11,894 | 13 | 8,494 | 19 |
| Fastify | 65,825 | 2 | 37,689 | 2 |
| Hono | 65,363 | 1 | 33,241 | 3 |
| Express | 12,068 | 9 | 10,004 | 11 |
| NestJS | 10,899 | 12 | 9,464 | 12 |

Inferlo is currently at the level of Express and NestJS and well behind Fastify and Hono. A CPU profile of the request pipeline shows where the time goes: garbage collection, an `AbortSignal.any` per request for `ctx.signal`, and per-request objects that most handlers never use. Closing that gap is on the [roadmap](../ROADMAP.md) (performance part 2), followed by a CI check that fails when a change makes Inferlo slower (part 3). This page is updated with every new measurement.

Numbers depend on the machine, the Node.js version and the load. Compare frameworks within one run, and run the benchmark on hardware like your production servers before drawing conclusions.
