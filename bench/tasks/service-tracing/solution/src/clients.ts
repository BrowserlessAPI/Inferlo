import { serviceClient } from "@browserlessapi/inferlo";
import * as otel from "@opentelemetry/api";
import { settings } from "./config.ts";

// Each call gets a client span and sends its traceparent, so billing's spans join this request's trace.
export const billing = serviceClient({ baseUrl: "http://billing.internal", token: settings.BILLING_TOKEN, tracing: { api: otel } });
