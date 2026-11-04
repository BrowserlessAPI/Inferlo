import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Controller, Get, Inject, Injectable, Module, Post, Body } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createAI, mockProvider, t, type AI } from "../src/ai/public.ts";
import { bearer, createApp, InferloError, route, toNodeHandler } from "../src/index.ts";
import { INFERLO_AI, InferloModule } from "../src/nestjs.ts";

// Decorators are applied by hand: Node runs this file without a decorator transform.
function decorate<T extends abstract new (...args: any[]) => unknown>(target: T, classDecorators: ClassDecorator[], params: [index: number, decorator: ParameterDecorator][] = [], deps: unknown[] = []): T {
  Reflect.defineMetadata("design:paramtypes", deps, target);
  for (const [index, decorator] of params) decorator(target, undefined, index);
  for (const decorator of classDecorators) decorator(target);
  return target;
}
function method(target: object, key: string, ...decorators: (MethodDecorator | ParameterDecorator)[]) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
  for (const d of decorators) (d as MethodDecorator)(target, key, descriptor);
}

function makeAI(reply = '{"label":"bug"}') {
  const usage: { for?: string }[] = [];
  return { ai: createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" }, onUsage: (u) => void usage.push(u) }), usage };
}

async function listen(nest: { listen(port: number, host: string): Promise<unknown>; getHttpServer(): { address(): { port: number } } }) {
  await nest.listen(0, "127.0.0.1");
  return `http://127.0.0.1:${nest.getHttpServer().address().port}`;
}

describe("InferloModule for NestJS", () => {
  test("forRoot provides the AI client as INFERLO_AI to services in other modules", async () => {
    const { ai, usage } = makeAI();
    class ClassifyService {
      readonly ai: AI;
      constructor(ai: AI) {
        this.ai = ai;
      }
      async classify(text: string) {
        const { object } = await this.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }), for: "user-1" });
        return object;
      }
    }
    decorate(ClassifyService, [Injectable()], [[0, Inject(INFERLO_AI)]], [Object]);
    class ClassifyController {
      readonly service: ClassifyService;
      constructor(service: ClassifyService) {
        this.service = service;
      }
      classify(body: { text: string }) {
        return this.service.classify(body.text);
      }
    }
    method(ClassifyController.prototype, "classify", Post());
    Body()(ClassifyController.prototype, "classify", 0);
    decorate(ClassifyController, [Controller("classify")], [], [ClassifyService]);
    class FeatureModule {}
    decorate(FeatureModule, [Module({ controllers: [ClassifyController], providers: [ClassifyService] })]);
    class AppModule {}
    decorate(AppModule, [Module({ imports: [InferloModule.forRoot({ ai }), FeatureModule] })]);

    const nest = await NestFactory.create(AppModule, { logger: false });
    try {
      assert.equal(nest.get(INFERLO_AI), ai);
      const base = await listen(nest as never);
      const res = await fetch(`${base}/classify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "It crashes" }) });
      assert.equal(res.status, 201);
      assert.deepEqual(await res.json(), { label: "bug" });
      assert.equal(usage[0]?.for, "user-1");
    } finally {
      await nest.close();
    }
  });

  test("forRootAsync builds the client from other providers", async () => {
    const SETTINGS = "SETTINGS";
    class SettingsModule {}
    decorate(SettingsModule, [Module({ providers: [{ provide: SETTINGS, useValue: { reply: "from factory" } }], exports: [SETTINGS] })]);
    class AppModule {}
    decorate(AppModule, [Module({
      imports: [InferloModule.forRootAsync({
        imports: [SettingsModule],
        inject: [SETTINGS],
        useFactory: async (settings: { reply: string }) => createAI({ providers: { mock: mockProvider({ respond: () => settings.reply }) }, models: { fast: "mock:m" } }),
      })],
    })]);
    const nest = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      const ai = nest.get<AI>(INFERLO_AI);
      assert.equal((await ai.generate({ model: "fast", prompt: "hi" })).text, "from factory");
    } finally {
      await nest.close();
    }
  });

  test("a factory that returns something else fails at startup with IL5014", async () => {
    class AppModule {}
    decorate(AppModule, [Module({ imports: [InferloModule.forRootAsync({ useFactory: () => ({}) as AI })] })]);
    await assert.rejects(NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false }), (e: unknown) => e instanceof InferloError && e.code === "IL5014");
  });

  test("invalid options raise IL5014 or IL5016", () => {
    assert.throws(() => InferloModule.forRoot(undefined as never), (e: unknown) => e instanceof InferloError && e.code === "IL5016");
    assert.throws(() => InferloModule.forRoot({ ai: {} as AI }), (e: unknown) => e instanceof InferloError && e.code === "IL5014");
    assert.throws(() => InferloModule.forRootAsync({} as never), (e: unknown) => e instanceof InferloError && e.code === "IL5016");
    const { ai } = makeAI();
    assert.equal(InferloModule.forRoot({ ai, global: false }).global, false);
  });

  test("a whole Inferlo app mounts on the Express platform with toNodeHandler", async () => {
    const users: Record<string, { id: string; roles: string[] }> = { alice: { id: "alice", roles: [] } };
    const create = route.post("/notes", { body: t.object({ title: t.string().min(1) }) }).handle(({ body, status }) => {
      status(201);
      return body;
    });
    const inferlo = createApp({ routes: [{ create }], auth: bearer((token) => users[token] ?? null), logger: { info() {}, error() {} } });
    class HomeController {
      home() {
        return "nest home";
      }
    }
    method(HomeController.prototype, "home", Get());
    decorate(HomeController, [Controller()]);
    class AppModule {}
    decorate(AppModule, [Module({ controllers: [HomeController] })]);
    const nest = await NestFactory.create(AppModule, { logger: false, bodyParser: false });
    nest.use("/api", toNodeHandler(inferlo));
    try {
      const base = await listen(nest as never);
      assert.equal(await (await fetch(`${base}/`)).text(), "nest home");
      const json = { "content-type": "application/json" };
      assert.equal((await fetch(`${base}/api/notes`, { method: "POST", headers: json, body: JSON.stringify({ title: "Hi" }) })).status, 401);
      const signedIn = { ...json, authorization: "Bearer alice" };
      assert.equal((await fetch(`${base}/api/notes`, { method: "POST", headers: signedIn, body: JSON.stringify({ title: "" }) })).status, 422);
      const ok = await fetch(`${base}/api/notes`, { method: "POST", headers: signedIn, body: JSON.stringify({ title: "Hi" }) });
      assert.equal(ok.status, 201);
      assert.deepEqual(await ok.json(), { title: "Hi" });
      assert.ok((await (await fetch(`${base}/api/openapi.json`)).json()).paths["/notes"]);
    } finally {
      await nest.close();
    }
  });
});
