import { mail } from "@browserlessapi/inferlo";
import { settings } from "./config.ts";

export const mailer = mail({
  smtp: settings.SMTP_URL,
  from: "Acme <no-reply@acme.dev>",
  templates: {
    welcome: {
      subject: "Welcome to Acme, {{name}}",
      text: "Hi {{name}},\n\nYour Acme account is ready.",
      html: "<p>Hi {{name}},</p><p>Your Acme account is ready.</p>",
    },
  },
});
