import { createServer, type Server } from "node:http";

import type { SchedulerRuntime } from "./runtime.js";

export class SchedulerHealthServer {
  readonly #runtime: Pick<SchedulerRuntime, "getHealth" | "isReady">;
  readonly #host: string;
  readonly #port: number;
  #server: Server | undefined;

  constructor(options: { runtime: Pick<SchedulerRuntime, "getHealth" | "isReady">; host?: string; port?: number }) {
    this.#runtime = options.runtime;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 4010;
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return;
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("allow", "GET");
        response.end(JSON.stringify({ status: "method_not_allowed" }));
        return;
      }
      if (request.url === "/health/live") {
        const health = this.#runtime.getHealth();
        response.statusCode = health.status === "stopped" ? 503 : 200;
        response.end(JSON.stringify({ status: health.status, checked_at: health.checkedAt }));
        return;
      }
      if (request.url === "/health/ready") {
        const ready = await this.#runtime.isReady().catch(() => false);
        const health = this.#runtime.getHealth();
        response.statusCode = ready ? 200 : 503;
        response.end(JSON.stringify({ status: ready ? "ready" : "not_ready", checked_at: health.checkedAt }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ status: "not_found" }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
  }

  getAddress(): { host: string; port: number } | null {
    const address = this.#server?.address();
    return address !== null && address !== undefined && typeof address !== "string"
      ? { host: this.#host, port: address.port }
      : null;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
