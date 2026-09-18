/**
 * The /metrics listener.
 *
 * A separate `http.createServer` rather than a route on the Fastify app, for
 * three reasons that each matter on their own:
 *
 *   - app.ts states that there are exactly two API routes and the bar for a
 *     third is high. This does not clear that bar, and it does not have to:
 *     nothing about counters needs to be reachable from the public origin.
 *   - Bound to 127.0.0.1, so it is not reachable through Caddy or Cloudflare.
 *     The numbers are aggregate, but an in-flight gauge and a descriptor count
 *     are operationally useful to an attacker sizing a load test and useful to
 *     nobody else.
 *   - Off unless METRICS_PORT is set, which keeps the "this process prints two
 *     lines and opens one port" property intact for a self-hoster who copies
 *     the systemd unit.
 *
 * It answers exactly one path and 404s everything else. It reads a snapshot and
 * formats it; it never touches the relay path.
 */
import http from "node:http";
import { renderPrometheus, type MetricsSnapshot } from "./metrics.ts";

export interface MetricsServer {
  port: number;
  close(): Promise<void>;
}

/**
 * `collect` is injected rather than imported so the primary can hand back a
 * merged snapshot across cluster workers while a single process hands back its
 * own. This module does not need to know which it is.
 */
export async function startMetricsServer(
  port: number,
  collect: () => { snapshot: MetricsSnapshot; workers: number }
): Promise<MetricsServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("Not found\n");
      return;
    }
    let body: string;
    try {
      const { snapshot, workers } = collect();
      body = renderPrometheus(snapshot, { workers });
    } catch {
      // A broken scrape must never be able to take the relay down with it.
      res.writeHead(500, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("metrics unavailable\n");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // The literal 127.0.0.1 is asserted by verify-relay.ts. Do not replace it
    // with a configurable host: the point is that this cannot be published by
    // changing an environment variable.
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
