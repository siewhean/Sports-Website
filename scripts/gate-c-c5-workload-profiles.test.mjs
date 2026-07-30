import assert from "node:assert/strict";
import test from "node:test";
import {
  gateCC5OperationKinds,
  gateCC5WorkloadProfile,
  gateCC5WorkloadProfiles,
  selectGateCC5Operation,
} from "./gate-c-c5-workload-profiles.mjs";

test("C5 profiles retain the required event sizes", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(gateCC5WorkloadProfiles).map(([id, profile]) => [
        id,
        {
          teams: profile.teams,
          divisions: profile.divisions,
          playingAreas: profile.playingAreas,
          simultaneousOfficials: profile.simultaneousOfficials,
          concurrentPublicViewers: profile.concurrentPublicViewers,
        },
      ]),
    ),
    {
      small: { teams: 16, divisions: 2, playingAreas: 2, simultaneousOfficials: 4, concurrentPublicViewers: 100 },
      medium: {
        teams: 64,
        divisions: 6,
        playingAreas: 6,
        simultaneousOfficials: 12,
        concurrentPublicViewers: 500,
      },
      large: {
        teams: 128,
        divisions: 12,
        playingAreas: 12,
        simultaneousOfficials: 24,
        concurrentPublicViewers: 2_000,
      },
    },
  );
});

test("every required operation has a non-negative weight", () => {
  for (const profile of Object.values(gateCC5WorkloadProfiles)) {
    assert.deepEqual(Object.keys(profile.operationWeights).sort(), [...gateCC5OperationKinds].sort());
    assert.ok(profile.totalWeight > 0);
    for (const weight of Object.values(profile.operationWeights)) assert.ok(weight >= 0);
  }
});

test("weighted operation selection is deterministic and total", () => {
  const profile = gateCC5WorkloadProfile("small");
  const selected = [0, 0.1, 0.25, 0.5, 0.75, 0.999999].map((value) => selectGateCC5Operation(profile, value));
  assert.equal(selected.length, 6);
  assert.ok(selected.every((kind) => gateCC5OperationKinds.includes(kind)));
  assert.deepEqual(selected, [0, 0.1, 0.25, 0.5, 0.75, 0.999999].map((value) => selectGateCC5Operation(profile, value)));
});

test("invalid profile and selector input fail closed", () => {
  assert.throws(() => gateCC5WorkloadProfile("unknown"), /Unknown/);
  assert.throws(() => selectGateCC5Operation(gateCC5WorkloadProfile("small"), -0.1), /\[0,1\)/);
  assert.throws(() => selectGateCC5Operation(gateCC5WorkloadProfile("small"), 1), /\[0,1\)/);
});
