import { describe, expect, it } from "vitest";

import {
  parseGateCC5CacheLifecycleTarget,
  redactGateCC5CacheLifecycleTarget,
  STAGING_CONFIRMATION,
} from "../../src/gate-c-c5-cache-lifecycle-runner.js";

const target = {
  APP_ENV: "staging",
  GATE_C_C5_DISPOSABLE_FIXTURE_CONFIRMATION: STAGING_CONFIRMATION,
  DATABASE_URL: "postgres://fixture:secret@staging-db.example/matchday",
  REDIS_URL: "rediss://default:secret@staging-redis.example:6379/0",
  GATE_C_C5_EVIDENCE_DIR: "/srv/matchday/artifacts/qa/gate-c-c5/0123456789012345678901234567890123456789/run-1",
  GATE_C_C5_API_ORIGIN: "https://api.c5-staging.example.com",
  GATE_C_C5_EDGE_ORIGIN: "https://c5-staging.example.com",
};

describe("C5 staging cache-lifecycle target", () => {
  it("accepts only an explicit staging target and does not return credential bytes", () => {
    const parsed = parseGateCC5CacheLifecycleTarget(target);
    expect(parsed.apiOrigin.origin).toBe("https://api.c5-staging.example.com");
    expect(parsed.edgeOrigin.origin).toBe("https://c5-staging.example.com");
    const retained = JSON.stringify(redactGateCC5CacheLifecycleTarget(parsed));
    expect(retained).not.toContain("fixture:secret");
    expect(retained).not.toContain("default:secret");
  });

  it.each([
    [{ ...target, APP_ENV: "production" }, "APP_ENV=staging"],
    [{ ...target, GATE_C_C5_DISPOSABLE_FIXTURE_CONFIRMATION: "yes" }, "explicit disposable"],
    [{ ...target, GATE_C_C5_API_ORIGIN: "http://api.c5-staging.example.com" }, "trusted HTTPS"],
    [{ ...target, GATE_C_C5_EVIDENCE_DIR: "/tmp/receipts" }, "exact-SHA artifact root"],
  ])("fails closed for unsafe configuration", (environment, message) => {
    expect(() => parseGateCC5CacheLifecycleTarget(environment)).toThrow(message);
  });
});
