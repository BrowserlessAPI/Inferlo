import * as Sentry from "@sentry/node";

/** Events Sentry would send, for the checks. In production Sentry.init gets the project's DSN and sends them. */
export const captured: Record<string, any>[] = [];

Sentry.init({
  dsn: "https://public@o0.ingest.sentry.io/0",
  defaultIntegrations: false,
  beforeSend(event) {
    captured.push(event);
    return null;
  },
} as Sentry.NodeOptions);

export { Sentry };
