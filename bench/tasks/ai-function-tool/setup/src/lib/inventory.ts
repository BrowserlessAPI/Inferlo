/** Stock levels by SKU. Do not change this file. */
const stock: Record<string, number> = { "SKU-1": 12, "SKU-2": 0 };

export async function stockLevel(sku: string): Promise<number | undefined> {
  return stock[sku];
}
