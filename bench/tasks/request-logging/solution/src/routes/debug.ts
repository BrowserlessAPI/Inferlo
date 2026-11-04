import { route } from "@browserlessapi/inferlo";

export const requestInfo = route.get("/debug/request", { auth: "public" }).handle(({ requestId }) => ({ requestId }));
