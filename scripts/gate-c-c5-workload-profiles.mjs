const operationKinds = Object.freeze([
  "score_event_write",
  "session_refresh",
  "offline_replay",
  "public_schedule_read",
  "public_result_read",
  "standings_read",
  "bracket_read",
  "repair_analysis",
  "repair_draft_save",
  "repair_publication",
  "schedule_pdf_generation",
  "score_sheet_generation",
  "conditional_etag_read",
]);

const baseWeights = Object.freeze({
  score_event_write: 18,
  session_refresh: 10,
  offline_replay: 4,
  public_schedule_read: 16,
  public_result_read: 16,
  standings_read: 8,
  bracket_read: 6,
  repair_analysis: 2,
  repair_draft_save: 2,
  repair_publication: 1,
  schedule_pdf_generation: 1,
  score_sheet_generation: 2,
  conditional_etag_read: 14,
});

function profile(input) {
  const weights = { ...baseWeights, ...input.operationWeights };
  const missing = operationKinds.filter((kind) => !Number.isFinite(weights[kind]) || weights[kind] < 0);
  if (missing.length > 0) throw new Error(`Invalid C5 workload weights: ${missing.join(", ")}`);
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) throw new Error("A C5 workload profile needs positive operation weight");
  return Object.freeze({
    schemaVersion: 1,
    ...input,
    operationWeights: Object.freeze(weights),
    totalWeight,
  });
}

export const gateCC5WorkloadProfiles = Object.freeze({
  small: profile({
    id: "small",
    teams: 16,
    divisions: 2,
    playingAreas: 2,
    simultaneousOfficials: 4,
    concurrentPublicViewers: 100,
    targetRequestsPerSecond: 25,
    burstRequestsPerSecond: 60,
    defaultDurationSeconds: 120,
  }),
  medium: profile({
    id: "medium",
    teams: 64,
    divisions: 6,
    playingAreas: 6,
    simultaneousOfficials: 12,
    concurrentPublicViewers: 500,
    targetRequestsPerSecond: 100,
    burstRequestsPerSecond: 250,
    defaultDurationSeconds: 300,
  }),
  large: profile({
    id: "large",
    teams: 128,
    divisions: 12,
    playingAreas: 12,
    simultaneousOfficials: 24,
    concurrentPublicViewers: 2_000,
    targetRequestsPerSecond: 300,
    burstRequestsPerSecond: 750,
    defaultDurationSeconds: 600,
    operationWeights: {
      public_schedule_read: 18,
      public_result_read: 18,
      conditional_etag_read: 18,
      repair_publication: 0.5,
    },
  }),
});

export { operationKinds as gateCC5OperationKinds };

export function gateCC5WorkloadProfile(profileId) {
  const selected = gateCC5WorkloadProfiles[profileId];
  if (!selected) throw new Error(`Unknown Gate C C5 workload profile: ${profileId}`);
  return selected;
}

export function selectGateCC5Operation(profile, unitInterval) {
  if (!Number.isFinite(unitInterval) || unitInterval < 0 || unitInterval >= 1) {
    throw new Error("Operation selector requires a number in [0,1)");
  }
  let cursor = unitInterval * profile.totalWeight;
  for (const kind of operationKinds) {
    cursor -= profile.operationWeights[kind];
    if (cursor < 0) return kind;
  }
  return operationKinds.at(-1);
}
