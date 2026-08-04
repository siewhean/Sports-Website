import { describe, expect, it } from "vitest";
import { parseGateCC5MaximumSamples, parseGateCC5WorkloadProfile } from "../../scripts/gate-c-c5-workload-profile.js";

const profile = JSON.stringify({
  profileId: "pilot-score-writes",
  durationSeconds: 15,
  scorekeeperCount: 2,
  publicReaderCount: 1,
  organiserWorkerCount: 1,
  approval: {
    owner: "Operations owner",
    approvedAtUtc: "2026-08-04T00:00:00Z",
    reference: "OPS-42",
  },
});

describe("C5 workload profile input", () => {
  it("accepts one explicit approved non-secret profile", () => {
    expect(parseGateCC5WorkloadProfile(profile)).toMatchObject({ profileId: "pilot-score-writes" });
    expect(parseGateCC5MaximumSamples(undefined)).toBe(100);
  });

  it.each([
    [undefined, "requires"],
    ["{", "valid JSON"],
    [JSON.stringify({ ...JSON.parse(profile), endpoint: "https://production.example" }), "unsupported field"],
    [
      JSON.stringify({
        ...JSON.parse(profile),
        approval: { owner: "Operations owner", approvedAtUtc: "2026-08-04T00:00:00Z" },
      }),
      "unsupported field",
    ],
    [JSON.stringify({ ...JSON.parse(profile), scorekeeperCount: "two" }), "scorekeeperCount must be an integer"],
    [
      JSON.stringify({ ...JSON.parse(profile), approval: { ...JSON.parse(profile).approval, owner: null } }),
      "owner must be a string",
    ],
    [
      JSON.stringify({
        ...JSON.parse(profile),
        approval: { ...JSON.parse(profile).approval, reference: "https://secret.example" },
      }),
      "reference must not contain secret-like content",
    ],
  ])("rejects invalid profile input", (input, message) => {
    expect(() => parseGateCC5WorkloadProfile(input)).toThrow(message);
  });

  it("rejects malformed sample bounds", () => {
    expect(() => parseGateCC5MaximumSamples("0")).toThrow("1 to 1000000");
    expect(() => parseGateCC5MaximumSamples("1.5")).toThrow("integer");
  });
});
