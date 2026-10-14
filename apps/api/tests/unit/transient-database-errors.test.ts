import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, isTransientDatabaseError } from "../../src/app.js";
import type { IdentityApiRuntime } from "../../src/identity-runtime.js";
import type { Phase2Runtime } from "../../src/phase-2-runtime.js";
import { healthyProbes, testConfig } from "../helpers.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

// Drive the real POST /api/v1/scoring/events route with a runtime whose append throws.
async function appendFailingWith(failure: unknown) {
  const runtime = {
    scoringSessionRateLimitSubject: async () => null,
    appendCanonicalScoreEvent: async () => {
      throw failure;
    },
  } as unknown as Phase2Runtime;
  // Scoring routes are only registered alongside the identity runtime; append never touches it.
  const app = await buildApp({
    config: testConfig(),
    probes: healthyProbes,
    identityRuntime: {} as IdentityApiRuntime,
    phase2Runtime: runtime,
  });
  apps.push(app);
  return app.inject({
    method: "POST",
    url: "/api/v1/scoring/events",
    headers: {
      "x-scoring-session-id": randomUUID(),
      "x-scoring-session-token": "t".repeat(40),
      "x-writer-generation": "1",
    },
    payload: {
      client_event_id: randomUUID(),
      expected_sequence: 0,
      type: "match_started",
      occurred_at: new Date().toISOString(),
    },
  });
}

describe("transient database errors on scoring append", () => {
  it.each([
    "40001",
    "40P01",
    "57P01",
    "08006",
    "55P03",
    "57014",
    "CONNECTION_CLOSED",
    "CONNECTION_ENDED",
    "ECONNRESET",
  ])("maps %s to 503 SERVICE_BUSY with retry-after", async (code) => {
    const response = await appendFailingWith(Object.assign(new Error(`simulated ${code}`), { code }));
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("2");
    expect(response.json()).toMatchObject({
      error: { code: "SERVICE_BUSY", message: "Service is busy, please retry" },
    });
  });

  it("detects a transient code on a wrapped cause", () => {
    const inner = Object.assign(new Error("deadlock"), { code: "40P01" });
    expect(isTransientDatabaseError(new Error("query failed", { cause: inner }))).toBe(true);
  });

  it("keeps non-transient database errors as 500", async () => {
    expect(isTransientDatabaseError(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
    const response = await appendFailingWith(Object.assign(new Error("syntax"), { code: "42601" }));
    expect(response.statusCode).toBe(500);
    expect(response.headers["retry-after"]).toBeUndefined();
  });
});
