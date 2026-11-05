// NestJS on its default Express platform, with the same body check as the Inferlo schema.
import "reflect-metadata";
import { Body, Controller, Get, HttpCode, HttpException, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { validEcho } from "./checks.ts";

class PerfController {
  hello() {
    return { hello: "world" };
  }
  echo(body: unknown) {
    if (!validEcho(body)) throw new HttpException({ error: "invalid body" }, 422);
    return { name: body.name, count: body.count };
  }
}
// Decorators applied as functions: the benchmark runs the TypeScript source with Node.js type stripping.
Get("hello")(PerfController.prototype, "hello", Object.getOwnPropertyDescriptor(PerfController.prototype, "hello")!);
Post("echo")(PerfController.prototype, "echo", Object.getOwnPropertyDescriptor(PerfController.prototype, "echo")!);
HttpCode(200)(PerfController.prototype, "echo", Object.getOwnPropertyDescriptor(PerfController.prototype, "echo")!);
Body()(PerfController.prototype, "echo", 0);
Controller()(PerfController);

class PerfModule {}
Module({ controllers: [PerfController] })(PerfModule);

const app = await NestFactory.create(PerfModule, { logger: false });
await app.listen(Number(process.env.PORT), "127.0.0.1");
process.send?.("ready");
