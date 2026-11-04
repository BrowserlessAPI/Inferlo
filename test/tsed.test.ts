import "reflect-metadata";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { DITest, Inject, Injectable } from "@tsed/di";
import { createAI, mockProvider, t } from "../src/ai/public.ts";
import { createApp, InferloError } from "../src/index.ts";
import { InferloAI, inferloAI } from "../src/tsed.ts";

// Decorators are applied by hand: Node runs this file without a decorator transform.
function decorate<T extends abstract new (...args: any[]) => unknown>(target: T, classDecorators: ClassDecorator[], params: [index: number, decorator: ParameterDecorator][] = [], deps: unknown[] = []): T {
  Reflect.defineMetadata("design:paramtypes", deps, target);
  for (const [index, decorator] of params) decorator(target, undefined, index);
  for (const decorator of classDecorators) decorator(target);
  return target;
}

const makeAI = (reply = '{"label":"bug"}') => createAI({ providers: { mock: mockProvider({ respond: () => reply }) }, models: { fast: "mock:m" } });

class ClassifyService {
  readonly ai: InferloAI;
  constructor(ai: InferloAI) {
    this.ai = ai;
  }
  async classify(text: string) {
    const { object } = await this.ai.generate({ model: "fast", prompt: text, output: t.object({ label: t.enum(["bug", "feature"]) }) });
    return object;
  }
}
// constructor(private readonly ai: InferloAI): the type is the token, as emitDecoratorMetadata writes it.
decorate(ClassifyService, [Injectable()], [], [InferloAI]);

class ExplicitService {
  readonly ai: InferloAI;
  constructor(ai: InferloAI) {
    this.ai = ai;
  }
}
// constructor(@Inject(InferloAI) ai: InferloAI)
decorate(ExplicitService, [Injectable()], [[0, Inject(InferloAI) as ParameterDecorator]], [Object]);

describe("Ts.ED", () => {
  afterEach(() => DITest.reset());

  test("inferloAI(ai) in imports provides the client as InferloAI to services", async () => {
    const ai = makeAI();
    await DITest.create({ imports: [inferloAI(ai)] });
    assert.equal(DITest.get(InferloAI), ai);
    const service = await DITest.invoke<ClassifyService>(ClassifyService);
    assert.equal(service.ai, ai);
    assert.deepEqual(await service.classify("It crashes"), { label: "bug" });
    assert.equal((await DITest.invoke<ExplicitService>(ExplicitService)).ai, ai);
  });

  test("an Inferlo app's app.ai works too, and a factory can create the client at startup", async () => {
    const app = createApp({ ai: { providers: { mock: mockProvider({ respond: () => "hi" }) }, models: { fast: "mock:m" } } });
    await DITest.create({ imports: [inferloAI(app.ai)] });
    assert.equal(DITest.get(InferloAI), app.ai);
    await DITest.reset();
    await DITest.create({ imports: [{ token: InferloAI, useFactory: () => makeAI('{"label":"feature"}') }] });
    assert.deepEqual(await (await DITest.invoke<ClassifyService>(ClassifyService)).classify("Add dark mode"), { label: "feature" });
  });

  test("tests replace the client with a mock the same way", async () => {
    const mock = makeAI('{"label":"feature"}');
    await DITest.create();
    const service = await DITest.invoke<ClassifyService>(ClassifyService, [inferloAI(mock)]);
    assert.equal(service.ai, mock);
  });

  test("anything but an AI client raises IL5014", () => {
    for (const bad of [undefined, null, {}, { generate() {} }, "ai"]) {
      assert.throws(() => inferloAI(bad as never), (e: unknown) => e instanceof InferloError && e.code === "IL5014" && /Configuration\(\{ imports: \[inferloAI\(ai\)\] \}\)/.test(e.fix ?? ""));
    }
  });

  test("the provider is a plain object, so this entry point does not load Ts.ED", () => {
    const ai = makeAI();
    const provider = inferloAI(ai);
    assert.deepEqual(Object.keys(provider), ["token", "use"]);
    assert.equal(provider.token, InferloAI);
    assert.equal(provider.use, ai);
  });
});
