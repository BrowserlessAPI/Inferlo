// The body check for frameworks without built-in validation: the same rules as the Inferlo and Fastify schemas.
export function validEcho(body: unknown): body is { name: string; count: number } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const { name, count, ...rest } = body as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    typeof name === "string" && name.length >= 1 && name.length <= 100 &&
    typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 1000
  );
}
