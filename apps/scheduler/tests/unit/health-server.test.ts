import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerHealthServer } from "../../src/health-server.js";

describe("SchedulerHealthServer", () => {
  let server: SchedulerHealthServer | undefined;
  afterEach(async () => server?.stop());

  it("separates liveness from dependency-backed readiness and disables caching", async () => {
    const runtime = {
      getHealth: vi.fn(() => ({ status: "ready" as const, checkedAt: "2026-07-20T00:00:00.000Z" })),
      isReady: vi.fn(async () => false),
    };
    server = new SchedulerHealthServer({ runtime, port: 0 });
    await server.start();
    const address = server.getAddress();
    expect(address).not.toBeNull();

    const live = await fetch(`http://${address!.host}:${address!.port}/health/live`);
    const ready = await fetch(`http://${address!.host}:${address!.port}/health/ready`);

    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "not_ready", checked_at: "2026-07-20T00:00:00.000Z" });
  });
});
