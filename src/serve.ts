/** Start an HTTP server on Bun, Deno or Node using the app's fetch handler. */
import type { App } from "./app.ts";
import { clientIps } from "./client-ip.ts";

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

export interface Server {
  port: number;
  close(): Promise<void>;
}

export async function serve(app: Pick<App<any>, "fetch">, options: ServeOptions = {}): Promise<Server> {
  const port = options.port ?? 3000;
  const hostname = options.hostname ?? "0.0.0.0";
  const g = globalThis as {
    Bun?: { serve(o: object): { port: number; stop(force?: boolean): void } };
    Deno?: { serve(o: object, h: (r: Request, info: unknown) => Promise<Response>): { addr: { port: number }; shutdown(): Promise<void> } };
  };

  if (g.Bun) {
    const server = g.Bun.serve({ port, hostname, fetch: (req: Request, bunServer: unknown) => app.fetch(req, bunServer) });
    return { port: server.port, close: async () => server.stop(true) };
  }
  if (g.Deno) {
    const server = g.Deno.serve({ port, hostname }, (req, info) => app.fetch(req, info));
    return { port: server.addr.port, close: () => server.shutdown() };
  }

  const http = await import("node:http");
  const { Readable } = await import("node:stream");
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `localhost:${port}`;
      const url = new URL(req.url ?? "/", `http://${host}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) headers.append(k, item);
        else headers.set(k, v);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) controller.abort();
      });
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        signal: controller.signal,
        // @ts-expect-error duplex is required by Node for streaming bodies
        duplex: "half",
      });
      if (req.socket.remoteAddress) clientIps.set(request, req.socket.remoteAddress);
      const response = await app.fetch(request);
      const outHeaders: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (key === "set-cookie") return;
        outHeaders[key] = value;
      });
      const cookies = response.headers.getSetCookie?.() ?? [];
      if (cookies.length) outHeaders["set-cookie"] = cookies;
      res.writeHead(response.status, outHeaders);
      if (!response.body || req.method === "HEAD") return void res.end();
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((r) => res.once("drain", r));
      }
      res.end();
    } catch (error) {
      console.error("[inferlo] server error", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "IL9000", message: "Internal server error" } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
