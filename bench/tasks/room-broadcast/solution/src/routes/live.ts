import { route, t } from "@browserlessapi/inferlo";

export const watch = route
  .ws("/live", { message: t.object({ room: t.string().min(1).max(100) }), summary: "Watch a room" })
  .handle(({ message, socket }) => {
    socket.join(message.room);
    return { watching: message.room };
  });

export const announce = route
  .post("/announcements", { auth: "admin", body: t.object({ room: t.string().min(1).max(100), text: t.string().min(1).max(500) }), summary: "Announce to a room" })
  .handle(async ({ body, sockets }) => {
    await sockets.broadcast(body.room, { type: "announcement", text: body.text });
    return { sent: true };
  });
