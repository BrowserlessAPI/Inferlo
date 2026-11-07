import { natsEventTransport, type NatsConnection } from "@browserlessapi/inferlo/nats";

// createApp({ name: "bench-app", events: { transport: eventsTransport(nc) } })
export function eventsTransport(nc: NatsConnection) {
  return natsEventTransport(nc, { service: "bench-app", staleAfterMs: 10_000 });
}
