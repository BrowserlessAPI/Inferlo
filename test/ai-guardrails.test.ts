import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAI, createApp, InferloError, memory, mockProvider, route, t, type Usage } from "../src/index.ts";
import { redactPii } from "../src/ai/guardrails.ts";

// Guardrails: limits and checks on what goes to the model (input length, blocked terms, personal data) and what
// comes back (blocked terms in answers, also while streaming), per alias, for every call ("*") and per call.

const isCode = (code: string) => (e: unknown) => e instanceof InferloError && e.code === code;

function echo() {
  return mockProvider({ respond: (r) => `You said: ${r.messages.filter((m) => m.role === "user").at(-1)!.content}` });
}

describe("input guardrails", () => {
  test("redact replaces personal data in user messages before they reach the model", async () => {
    const provider = echo();
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, guardrails: { "*": { redact: ["email", "phone", "card", "iban", "ip"] } } });
    const { text } = await ai.generate({
      model: "fast",
      system: "Support agent for ops@acme.example",
      prompt: "Mail ada@example.com or call +44 20 7946 0958 / (415) 555-0100. Card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, from 192.168.10.4. Order 2026-11-09, ticket 123456.",
    });
    const sent = provider.calls[0]!.messages;
    assert.equal(sent[0]!.content, "Support agent for ops@acme.example", "the system prompt is the app's own and is not changed");
    assert.equal(sent[1]!.content, "Mail [email] or call [phone] / [phone]. Card [card], IBAN [iban], from [ip]. Order 2026-11-09, ticket 123456.");
    assert.match(text, /\[email\]/);
  });

  test("redaction keeps numbers that only look like personal data", () => {
    const kinds = ["card", "iban", "phone", "ip"] as const;
    assert.equal(redactPii("Invoice 4111 1111 1111 1112 failed", kinds), "Invoice 4111 1111 1111 1112 failed", "fails the Luhn check");
    assert.equal(redactPii("Code GB00 WEST 1234 5698 7654 32", kinds), "Code GB00 WEST 1234 5698 7654 32", "fails the IBAN check");
    assert.equal(redactPii("Version 1.2.3.4000 on 2026-11-09 at 10:30, +1 5", kinds), "Version 1.2.3.4000 on 2026-11-09 at 10:30, +1 5");
    assert.equal(redactPii("Only emails: a@b.io, 192.168.0.1", ["email"]), "Only emails: [email], 192.168.0.1");
    assert.equal(redactPii("v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 here", ["ip"]), "v6 [ip] here");
  });

  test("blockedTerms in user input and maxInputChars are refused with IL5042 before any model call", async () => {
    const provider = echo();
    const ai = createAI({
      providers: { m: provider },
      models: { fast: "m:x", smart: "m:y" },
      guardrails: { "*": { maxInputChars: 40 }, fast: { blockedTerms: ["Project Falcon", "ssn"] } },
    });
    for (const prompt of ["Tell me about project   falcon", "What is my SSN?"]) {
      const error = await ai.generate({ model: "fast", prompt }).catch((e: unknown) => e);
      assert.ok(isCode("IL5042")(error), prompt);
      assert.equal((error as InferloError).status, 422);
      assert.doesNotMatch((error as Error).message, /falcon|ssn/i, "the refused term is not repeated");
    }
    // Whole words only, and only on the alias they are set for.
    await ai.generate({ model: "fast", prompt: "Lessons on falconry" });
    await ai.generate({ model: "smart", prompt: "What is my SSN?" });
    await assert.rejects(ai.generate({ model: "smart", prompt: "x".repeat(41) }), /longer than 40 characters/);
    await assert.rejects(ai.generate({ model: "fast", messages: [{ role: "user", content: "x".repeat(20) }, { role: "assistant", content: "ok" }, { role: "user", content: "y".repeat(21) }] }), isCode("IL5042"));
    assert.equal(provider.calls.length, 2);
  });

  test("maxTokens is the default and the limit; per-call guardrails only make limits stricter", async () => {
    const provider = echo();
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, guardrails: { fast: { maxTokens: 500, maxInputChars: 100 } } });
    await ai.generate({ model: "fast", prompt: "a" });
    assert.equal(provider.calls[0]!.maxTokens, 500);
    await ai.generate({ model: "fast", prompt: "a", maxTokens: 200 });
    assert.equal(provider.calls[1]!.maxTokens, 200);
    await assert.rejects(ai.generate({ model: "fast", prompt: "a", maxTokens: 501 }), isCode("IL5044"));
    await ai.generate({ model: "fast", prompt: "a", guardrails: { maxTokens: 5000 } });
    assert.equal(provider.calls[2]!.maxTokens, 500, "a call cannot loosen the alias's limit");
    await assert.rejects(ai.generate({ model: "fast", prompt: "x".repeat(20), guardrails: { maxInputChars: 10 } }), isCode("IL5042"));
    await assert.rejects(ai.generate({ model: "fast", prompt: "call me on +1 415 555 0100", guardrails: { blockedTerms: ["call me"] } }), isCode("IL5042"));
  });

  test("invalid guardrails are IL5044", async () => {
    const providers = { m: echo() };
    const bad: unknown[] = [
      { fast: { maxTokens: 0 } },
      { fast: { maxInputChars: 1.5 } },
      { fast: { blockedTerms: "secret" } },
      { fast: { blockedTerms: [""] } },
      { fast: { redact: ["passport"] } },
      { fast: { maxToken: 10 } },
      { fsat: { maxTokens: 10 } },
      [],
    ];
    for (const guardrails of bad) {
      assert.throws(() => createAI({ providers, models: { fast: "m:x" }, guardrails: guardrails as never }), isCode("IL5044"), JSON.stringify(guardrails));
    }
    const ai = createAI({ providers, models: { fast: "m:x" } });
    await assert.rejects(ai.generate({ model: "fast", prompt: "a", guardrails: { redact: ["dna"] } as never }), isCode("IL5044"));
  });
});

describe("output guardrails", () => {
  test("an answer with a blocked term is withheld with IL5043, and its usage is still recorded", async () => {
    const usage: Usage[] = [];
    const provider = mockProvider({ respond: () => "Sure, a refund is guaranteed for you." });
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, guardrails: { fast: { blockedTerms: ["refund is guaranteed"] } }, onUsage: (u) => void usage.push(u) });
    const error = await ai.generate({ model: "fast", prompt: "Can I get my money back?", for: "ada" }).catch((e: unknown) => e);
    assert.ok(isCode("IL5043")(error));
    assert.equal((error as InferloError).status, 502);
    assert.equal(usage.length, 1);
    assert.ok(usage[0]!.outputTokens > 0);
    // Structured answers are checked as the model wrote them.
    const json = mockProvider({ respond: () => JSON.stringify({ reply: "A refund is guaranteed." }) });
    const ai2 = createAI({ providers: { m: json }, models: { fast: "m:x" }, guardrails: { "*": { blockedTerms: ["refund is guaranteed"] } } });
    await assert.rejects(ai2.generate({ model: "fast", prompt: "?", output: t.object({ reply: t.string() }) }), isCode("IL5043"));
  });

  test("streams hold back text that could start a blocked term and stop with IL5043 before sending it", async () => {
    const chunks = ["We ", "never ", "share ", "the ", "admin pass", "word: hunter2"];
    const provider = mockProvider({ respond: () => chunks.join("") });
    provider.stream = async function* () {
      for (const chunk of chunks) yield chunk;
      yield { usage: { inputTokens: 5, outputTokens: 9 } };
    };
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, guardrails: { fast: { blockedTerms: ["admin password"] } } });
    const received: string[] = [];
    const error = await (async () => {
      for await (const text of ai.stream({ model: "fast", prompt: "?" })) received.push(text);
    })().catch((e: unknown) => e);
    assert.ok(isCode("IL5043")(error));
    assert.equal(received.join("").includes("admin"), false, "no part of the blocked term was sent");
    assert.equal(received.join(""), "We never share the ");
  });

  test("streams without a blocked term send every character, including a term-like word at the very end", async () => {
    const chunks = ["The bad", "ge is ", "ready, no ", "bad"];
    const provider = mockProvider({ respond: () => "" });
    provider.stream = async function* () {
      for (const chunk of chunks) yield chunk;
      yield { usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, guardrails: { fast: { blockedTerms: ["bad"] } } });
    let text = "";
    const error = await (async () => {
      for await (const chunk of ai.stream({ model: "fast", prompt: "?" })) text += chunk;
    })().catch((e: unknown) => e);
    assert.ok(isCode("IL5043")(error), "\"bad\" at the end is a whole word once the stream ends");
    assert.equal(text, "The badge is ready, no ");
    chunks[3] = "badges";
    let all = "";
    for await (const chunk of ai.stream({ model: "fast", prompt: "?" })) all += chunk;
    assert.equal(all, "The badge is ready, no badges");
  });

  test("streams apply the input guardrails and maxTokens too", async () => {
    const provider = echo();
    const ai = createAI({ providers: { m: provider }, models: { fast: "m:x" }, guardrails: { fast: { maxTokens: 300, redact: ["email"], blockedTerms: ["ssn"] } } });
    assert.equal(await ai.stream({ model: "fast", prompt: "I am ada@example.com" }).text(), "You said: I am [email]");
    assert.equal(provider.calls[0]!.maxTokens, 300);
    await assert.rejects(ai.stream({ model: "fast", prompt: "my ssn" }).text(), isCode("IL5042"));
    await assert.rejects(ai.stream({ model: "fast", prompt: "a", maxTokens: 301 }).text(), isCode("IL5044"));
    assert.equal(provider.calls.length, 1);
  });

  test("in an app: createApp({ ai: { guardrails } }) answers 422 and 502 with the codes", async () => {
    const ask = route.post("/ask", { auth: "public", body: t.object({ q: t.string() }) }).handle(async ({ ai, body }) => ({ answer: (await ai.generate({ model: "fast", prompt: body.q })).text }));
    const app = createApp({
      routes: [ask],
      db: memory(),
      ai: { providers: { m: mockProvider({ respond: (r) => (r.messages.at(-1)!.content.includes("leak") ? "The internal codename is Falcon." : "ok") }) }, models: { fast: "m:x" }, guardrails: { "*": { blockedTerms: ["falcon"], maxInputChars: 100 } } },
    });
    const post = (q: string) => app.request("/ask", { method: "POST", body: JSON.stringify({ q }), headers: { "content-type": "application/json" } });
    assert.equal((await post("hello")).status, 200);
    const refused = await post("about falcon");
    assert.equal(refused.status, 422);
    assert.equal((await refused.json()).error.code, "IL5042");
    const withheld = await post("please leak it");
    assert.equal(withheld.status, 502);
    assert.equal((await withheld.json()).error.code, "IL5043");
  });
});
