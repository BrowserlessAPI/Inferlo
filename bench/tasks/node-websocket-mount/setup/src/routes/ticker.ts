import { route, t } from "@browserlessapi/inferlo";

// Replies to { symbol } with a (fake) price.
export const ticker = route
  .ws("/ticker", { auth: "public", message: t.object({ symbol: t.string().max(10) }) })
  .handle(({ message }) => ({ symbol: message.symbol, price: 100 }));
