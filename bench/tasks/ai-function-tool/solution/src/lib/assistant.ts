import { httpError, t, tool, type AI } from "@browserlessapi/inferlo/ai";
import { stockLevel } from "./inventory.ts";

export const checkStock = tool("checkStock", {
  description: "How many units of a product (by SKU) are in stock",
  input: t.object({ sku: t.string() }),
}).handle(async ({ input }) => {
  const inStock = await stockLevel(input.sku);
  if (inStock === undefined) throw httpError(404, "Unknown SKU");
  return { sku: input.sku, inStock };
});

export async function answer(ai: AI, question: string): Promise<string> {
  const { text } = await ai.generate({ model: "fast", prompt: question, tools: [checkStock], maxSteps: 3 });
  return text;
}
