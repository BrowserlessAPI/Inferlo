"use server";
// A Next.js server action using Inferlo's AI module: <form action={classify}> in a page.
import { ai } from "../lib/ai.ts";
import { classifyText } from "../lib/classify.ts";

export async function classify(formData: FormData): Promise<{ label: "bug" | "feature" | "question" }> {
  const text = String(formData.get("text") ?? "").slice(0, 5_000);
  return classifyText(ai, text);
}
