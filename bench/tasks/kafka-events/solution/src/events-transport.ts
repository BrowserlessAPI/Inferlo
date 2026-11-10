import { kafkaEventTransport, type KafkaClient } from "@browserlessapi/inferlo/kafka";

export function eventsTransport(kafka: KafkaClient) {
  return kafkaEventTransport(kafka, { service: "bench-app", partitions: 6, staleAfterMs: 10_000 });
}
