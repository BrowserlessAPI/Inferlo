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

Measured on 2026-11-05 with Inferlo from the main branch after performance part 2a (Fastify 5.12, Hono 4.13, Express 5.3, NestJS 12.3), Node.js 22.23.4 on Linux x64, Intel Xeon @ 2.10GHz with 2 CPUs; 50 connections, 10 s per route after a 3 s warm-up. The load generator shares the 2 CPUs with the server, so the fastest frameworks are partly limited by it.

| Framework | `GET /hello` req/s | p99 ms | `POST /echo` req/s | p99 ms |
|---|---:|---:|---:|---:|
| Inferlo | 14,306 | 9 | 10,070 | 13 |
| Fastify | 57,727 | 2 | 37,438 | 3 |
| Hono | 60,899 | 2 | 33,337 | 3 |
| Express | 11,706 | 11 | 10,602 | 11 |
| NestJS | 10,593 | 12 | 8,019 | 15 |

Inferlo is at the level of Express and NestJS and behind Fastify and Hono.

### History

| Date | Change | Inferlo `GET /hello` req/s | `POST /echo` req/s |
|---|---|---:|---:|
| 2026-11-05 | First measurement (Inferlo 0.6.0) | 11,894 | 8,494 |
| 2026-11-05 | Part 2a: `ctx.signal`, `ctx.ai` and `ctx.audit` built on first use; the client's disconnect signal kept next to the Request instead of inside it; JSON answers written in one piece with `Content-Length` | 14,306 | 10,070 |

Each row was measured on the machine above, in the same run as the other frameworks. What is left, from CPU profiles: building a full Web `Request` and `Headers` for every Node.js request, reading the body through a Web stream, and garbage collection of those objects. Closing that gap is on the [roadmap](../ROADMAP.md) (performance part 2b). This page is updated with every new measurement.

## Regression check in CI

Every push runs `npm run bench:perf:check` (bench/perf/check.ts) in the "Performance regression check" CI job. It measures Inferlo and Fastify on both routes in three rounds (5 s per route after a 2 s warm-up) and fails when Inferlo's throughput **relative to Fastify's** drops below the floor for a route in `bench/perf/limits.json`:

```json
{ "minRatio": { "GET /hello (JSON)": 0.15, "POST /echo (validated JSON body)": 0.15 } }
```

- Absolute requests per second depend on the runner, so they are never compared: both frameworks run on the same machine in the same run, and the speed of the runner cancels out.
- Each round gives one Inferlo / Fastify ratio per route, and the check uses the median, so one noisy round does not decide the result. Errors or non-2xx answers under load fail the check.
- A floor is only ever raised: when a change makes Inferlo faster, raise the floor (leaving room for runner noise, about a quarter below the ratios CI reports) so the gain is kept. A change that falls below a floor is profiled and made faster, not merged with a lower floor.

The first floors are 0.15 for both routes, below the 0.26 to 0.36 measured on the machine above, while CI collects the ratios of its own runners; they are raised once those are known.

Run it locally with `npm run bench:perf:check`, or `node bench/perf/check.ts --rounds 5 --duration 10` for a steadier result.

Numbers depend on the machine, the Node.js version and the load. Compare frameworks within one run, and run the benchmark on hardware like your production servers before drawing conclusions.
