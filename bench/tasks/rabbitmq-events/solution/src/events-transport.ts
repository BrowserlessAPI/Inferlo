import { rabbitmqEventTransport, type AmqpConnection } from "@browserlessapi/inferlo/rabbitmq";

export function eventsTransport(connection: AmqpConnection) {
  return rabbitmqEventTransport(connection, { service: "bench-app", queueType: "classic" });
}
