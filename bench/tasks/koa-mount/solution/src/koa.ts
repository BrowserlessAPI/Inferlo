import Koa from "koa";
import { inferloAI, toKoaMiddleware } from "@browserlessapi/inferlo/koa";
import { app } from "./app.ts";

export function createKoaServer(): Koa {
  const koa = new Koa();
  koa.use(inferloAI(app.ai));
  koa.use(toKoaMiddleware(app, { prefix: "/api" }));
  koa.use((ctx) => {
    ctx.type = "text/plain";
    ctx.body = "koa";
  });
  return koa;
}
