import { afterEach, describe, expect, it } from "vitest";
import { isPhase2ScoringRouteEnabled } from "../../lib/feature-flags.server";
import { isScoringAccessToken } from "../../lib/scoring-access";

const environmentKey = "MATCHDAY_FEATURE_SCORING_PHASE2_ROUTE";
const initialValue = process.env[environmentKey];

afterEach(() => {
  if (initialValue === undefined) delete process.env[environmentKey];
  else process.env[environmentKey] = initialValue;
});

describe("score route feature flag", () => {
  it("uses the production-safe registry default when no override exists", async () => {
    delete process.env[environmentKey];
    await expect(isPhase2ScoringRouteEnabled()).resolves.toBe(true);
  });

  it("accepts typed boolean environment overrides", async () => {
    process.env[environmentKey] = "false";
    await expect(isPhase2ScoringRouteEnabled()).resolves.toBe(false);
    process.env[environmentKey] = "true";
    await expect(isPhase2ScoringRouteEnabled()).resolves.toBe(true);
  });

  it("ignores invalid overrides", async () => {
    process.env[environmentKey] = "prototype";
    await expect(isPhase2ScoringRouteEnabled()).resolves.toBe(true);
  });
});

describe("scoring access token route contract", () => {
  it("accepts only the API token length range", () => {
    expect(isScoringAccessToken("a".repeat(31))).toBe(false);
    expect(isScoringAccessToken("a".repeat(32))).toBe(true);
    expect(isScoringAccessToken("a".repeat(256))).toBe(true);
    expect(isScoringAccessToken("a".repeat(257))).toBe(false);
    expect(isScoringAccessToken(undefined)).toBe(false);
  });
});
