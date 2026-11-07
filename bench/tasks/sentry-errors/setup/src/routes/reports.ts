import { route } from "@browserlessapi/inferlo";

export const monthlyReport = route.get("/reports/monthly", { auth: "public", summary: "Monthly report" }).handle(() => {
  throw new Error("report service unavailable");
});
