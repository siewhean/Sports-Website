export const gateCC2Projects = [
  "gate-c-c2-phone-chromium",
  "gate-c-c2-phone-webkit",
  "gate-c-c2-desktop-chromium",
] as const;

export type GateCC2Project = (typeof gateCC2Projects)[number];

export const gateCC2Sports = ["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"] as const;
export const gateCC2ScreenshotStems = gateCC2Sports.flatMap((sport) => [
  `${sport.replaceAll("_", "-")}-live-scorer`,
  `${sport.replaceAll("_", "-")}-organiser-audit`,
]);
export const gateCC2BrowserSteps = [
  "match_started",
  "sport_action",
  "idempotent_replay",
  "sport_completion",
  "finalised",
  "organiser_reopen",
  "organiser_correction",
  "organiser_reopen",
  "refinalised",
  "audit_review",
] as const;

export type GateCC2BrowserReceipt = {
  artifact_kind: "gate-c-c2-browser-oracle";
  project_name: GateCC2Project;
  sports: Array<{
    sport_id: string;
    action_event_type: string;
    steps: string[];
    observed_result_versions: number[];
    observed_audit_event_count: number;
    displayed_result: string;
  }>;
  conflict_review: {
    sport_id: string;
    status: "acknowledged";
  };
  multi_division: {
    competition_id: string;
    primary_division_id: string;
    secondary_division_id: string;
    primary_result_versions: number[];
    secondary_result_versions: number[];
    public_packages_visible: boolean;
    cross_division_names_absent: boolean;
  };
};

export type GateCC2SemanticReceipt = {
  artifact_kind: "gate-c-c2-semantic-oracle";
  project_name: GateCC2Project;
  browser: GateCC2BrowserReceipt;
  database: {
    sports: Array<{
      sport_id: string;
      event_types: string[];
      sequences: number[];
      aggregate_versions: number[];
      row_count: number;
      distinct_client_event_count: number;
      result_versions: number[];
      result_states: string[];
      result_scores: string[];
      result_winners: string[];
      result_lifecycles: string[];
      result_segment_states: string[];
      publication_result_version: number;
      correction_transactions: number;
      correction_from_version: number;
      correction_through_version: number;
      correction_result_version: number;
      result_through_sequences: number[];
      stream_sport_code: string;
      stream_pack_version: string;
      settings_fingerprint: string;
      stream_current_version: number;
      reversal_target_count: number;
      reasoned_reversal_count: number;
      valid_actor_count: number;
      standings_result_version: number;
      standings_row_count: number;
      standings_settings_version: string;
      advancement_slot_count: number;
      advancement_conflict_count: number;
      audit_actions: string[];
      outbox_event_types: string[];
    }>;
    downstream_conflicts: {
      created: number;
      acknowledged: number;
      corrected_match_id: string;
      downstream_match_id: string;
      result_version: number;
      reason: string;
      acknowledgement_actor_present: boolean;
      acknowledgement_reason: string;
      audit_actions: string[];
      outbox_event_types: string[];
    };
    multi_division: {
      competition_id: string;
      division_ids: string[];
      global_result_versions: number[];
      primary_result_versions: number[];
      secondary_result_versions: number[];
      public_division_count: number;
      cross_division_reference_count: number;
    };
  };
};

function sameArray(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function canonicalGateCC2ResultSnapshot(snapshot: unknown): {
  winner: string | null;
  lifecycle: string;
  segmentState: string;
} {
  const parsed = typeof snapshot === "string" ? (JSON.parse(snapshot) as unknown) : snapshot;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gate C C2 persisted result snapshot is not a canonical object");
  }
  const candidate = parsed as Record<string, unknown>;
  const segments = candidate.segments;
  if (!Array.isArray(segments)) {
    throw new Error(
      `Gate C C2 persisted result snapshot has no canonical segments array; keys=${Object.keys(parsed).sort().join(",")}`,
    );
  }
  if (
    (candidate.winner !== null && candidate.winner !== "home" && candidate.winner !== "away") ||
    typeof candidate.lifecycle !== "string"
  ) {
    throw new Error("Gate C C2 persisted result snapshot has invalid canonical winner or lifecycle");
  }
  return {
    winner: candidate.winner,
    lifecycle: candidate.lifecycle,
    segmentState: JSON.stringify(
      segments.map((segment) => {
        if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
          throw new Error("Gate C C2 persisted result snapshot contains an invalid segment");
        }
        const item = segment as Record<string, unknown>;
        return {
          number: item.number,
          home: item.home,
          away: item.away,
          completed: item.completed,
          winner: item.winner,
        };
      }),
    ),
  };
}

export function validateGateCC2ScreenshotPaths(paths: unknown): readonly string[] {
  if (!Array.isArray(paths) || !paths.every((item): item is string => typeof item === "string")) {
    throw new Error("Gate C C2 screenshot receipt is missing");
  }
  for (const stem of gateCC2ScreenshotStems) {
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const matches = paths.filter((item) =>
      new RegExp(`(?:^|/)${escaped}(?:-[a-f0-9]{40,64})?\\.png$`, "u").test(item.replaceAll("\\", "/")),
    );
    if (matches.length !== 1) {
      throw new Error(`Gate C C2 screenshot receipt requires exactly one ${stem} image; found ${matches.length}`);
    }
  }
  return paths;
}

export function canonicalGateCC2ScreenshotPaths(paths: unknown): readonly string[] {
  if (!Array.isArray(paths) || !paths.every((item): item is string => typeof item === "string")) {
    throw new Error("Gate C C2 screenshot receipt is missing");
  }
  const canonical = paths.filter((item) => item.replaceAll("\\", "/").split("/").includes("attachments"));
  return validateGateCC2ScreenshotPaths(canonical);
}

function validSegmentState(value: string, sportId: (typeof gateCC2Sports)[number], winner: "home" | "away"): boolean {
  try {
    const segments = JSON.parse(value) as unknown;
    if (!Array.isArray(segments) || segments.length !== 1) return false;
    const segment = segments[0] as Record<string, unknown>;
    const awayWon = winner === "away";
    const score = sportId === "basketball" ? 3 : 1;
    const segmented = ["badminton", "table_tennis", "volleyball"].includes(sportId);
    return (
      Object.keys(segment).sort().join(",") === "away,completed,home,number,winner" &&
      segment.number === 1 &&
      segment.home === (awayWon ? 0 : score) &&
      segment.away === (awayWon ? score : 0) &&
      segment.completed === segmented &&
      segment.winner === (segmented ? winner : null)
    );
  } catch {
    return false;
  }
}

export function parseGateCC2Discovery(output: string): Map<GateCC2Project, number> {
  const counts = new Map<GateCC2Project, number>();
  for (const project of gateCC2Projects) {
    const escaped = project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const count = [...output.matchAll(new RegExp(`\\[${escaped}\\]`, "gu"))].length;
    if (count === 0) throw new Error(`Gate C C2 Playwright discovery found no tests for ${project}`);
    counts.set(project, count);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const reportedTotal = Number(output.match(/Total:\s+(\d+)\s+tests?/u)?.[1] ?? "0");
  if (reportedTotal !== total) {
    throw new Error(`Gate C C2 Playwright discovery total ${reportedTotal} does not match project total ${total}`);
  }
  return counts;
}

export function validateGateCC2BrowserReceipt(
  receipt: unknown,
  expectedProject: GateCC2Project,
): GateCC2BrowserReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("Gate C C2 browser oracle receipt is missing");
  const candidate = receipt as Partial<GateCC2BrowserReceipt>;
  if (
    candidate.artifact_kind !== "gate-c-c2-browser-oracle" ||
    candidate.project_name !== expectedProject ||
    !Array.isArray(candidate.sports) ||
    candidate.sports.length !== gateCC2Sports.length
  ) {
    throw new Error(`Gate C C2 browser oracle is not bound to ${expectedProject}`);
  }
  for (const [index, sport] of candidate.sports.entries()) {
    if (
      !sport ||
      sport.sport_id !== gateCC2Sports[index] ||
      typeof sport.action_event_type !== "string" ||
      !sameArray(sport.steps, gateCC2BrowserSteps) ||
      !sameArray(sport.observed_result_versions, sport.sport_id === "badminton" ? [1, 3, 4] : [1, 2, 3]) ||
      !Number.isSafeInteger(sport.observed_audit_event_count) ||
      sport.observed_audit_event_count < 1 ||
      typeof sport.displayed_result !== "string" ||
      !sport.displayed_result.trim()
    ) {
      throw new Error(`Gate C C2 browser oracle is incomplete for ${gateCC2Sports[index]}`);
    }
  }
  if (candidate.conflict_review?.sport_id !== "canoe_polo" || candidate.conflict_review.status !== "acknowledged") {
    throw new Error("Gate C C2 browser oracle does not prove downstream conflict review");
  }
  if (
    !candidate.multi_division ||
    !candidate.multi_division.competition_id ||
    candidate.multi_division.primary_division_id === candidate.multi_division.secondary_division_id ||
    !sameArray(candidate.multi_division.primary_result_versions, [1, 3, 4]) ||
    !sameArray(candidate.multi_division.secondary_result_versions, [2]) ||
    !candidate.multi_division.public_packages_visible ||
    !candidate.multi_division.cross_division_names_absent
  ) {
    throw new Error("Gate C C2 browser oracle does not prove two-division public isolation");
  }
  return candidate as GateCC2BrowserReceipt;
}

export function validateGateCC2SemanticReceipt(
  receipt: unknown,
  expectedProject: GateCC2Project,
): GateCC2SemanticReceipt {
  if (!receipt || typeof receipt !== "object") throw new Error("Gate C C2 semantic oracle receipt is missing");
  const candidate = receipt as Partial<GateCC2SemanticReceipt>;
  if (candidate.artifact_kind !== "gate-c-c2-semantic-oracle" || candidate.project_name !== expectedProject) {
    throw new Error(`Gate C C2 semantic oracle is not bound to ${expectedProject}`);
  }
  const browser = validateGateCC2BrowserReceipt(candidate.browser, expectedProject);
  if (!candidate.database || !Array.isArray(candidate.database.sports)) {
    throw new Error("Gate C C2 semantic oracle has no direct database evidence");
  }
  const database = candidate.database;
  for (const [index, sport] of database.sports.entries()) {
    const sportId = gateCC2Sports[index];
    const sequential = Array.from({ length: sport?.row_count ?? 0 }, (_, itemIndex) => itemIndex + 1);
    const completionEvent =
      sportId === "badminton" || sportId === "table_tennis"
        ? "game_completion"
        : sportId === "volleyball"
          ? "set_completion"
          : null;
    const requiredEventTypes = [
      "match_started",
      browser.sports[index]?.action_event_type,
      ...(completionEvent ? [completionEvent] : []),
      "finalisation",
      "match_reopened",
      "reversal",
    ];
    if (
      !sport ||
      sport.sport_id !== sportId ||
      sport.row_count < 8 ||
      sport.distinct_client_event_count !== sport.row_count ||
      !sameArray(sport.sequences, sequential) ||
      !sameArray(sport.aggregate_versions, sequential) ||
      !sameArray(sport.result_versions, sportId === "badminton" ? [1, 3, 4] : [1, 2, 3]) ||
      !sameArray(sport.result_states, ["final", "corrected", "final"]) ||
      !sameArray(sport.result_scores, [
        `${sportId === "basketball" ? 3 : 1}:0`,
        `0:${sportId === "basketball" ? 3 : 1}`,
        `0:${sportId === "basketball" ? 3 : 1}`,
      ]) ||
      !sameArray(sport.result_winners, ["home", "away", "away"]) ||
      !sameArray(sport.result_lifecycles, ["finalised", "finalised", "finalised"]) ||
      sport.result_segment_states.length !== 3 ||
      !validSegmentState(sport.result_segment_states[0] ?? "", sportId, "home") ||
      !validSegmentState(sport.result_segment_states[1] ?? "", sportId, "away") ||
      !validSegmentState(sport.result_segment_states[2] ?? "", sportId, "away") ||
      !browser.sports[index]?.displayed_result.includes(`0–${sportId === "basketball" ? 3 : 1}`) ||
      sport.publication_result_version !== (sportId === "badminton" ? 4 : 3) ||
      sport.correction_transactions !== 1 ||
      sport.correction_from_version < 1 ||
      sport.correction_through_version <= sport.correction_from_version ||
      sport.correction_result_version !== (sportId === "badminton" ? 3 : 2) ||
      !sameArray(sport.result_through_sequences, [
        sport.correction_from_version - 1,
        sport.correction_through_version,
        sport.row_count,
      ]) ||
      sport.stream_sport_code !== sportId ||
      !sport.stream_pack_version ||
      !/^[a-f0-9]{64}$/u.test(sport.settings_fingerprint) ||
      sport.stream_current_version !== sport.row_count ||
      sport.reversal_target_count !== 1 ||
      sport.reasoned_reversal_count !== 1 ||
      sport.valid_actor_count !== sport.row_count ||
      sport.standings_result_version !== (sportId === "badminton" ? 4 : 3) ||
      sport.standings_row_count < 1 ||
      !sport.standings_settings_version ||
      sport.advancement_slot_count < 0 ||
      sport.advancement_conflict_count < 0 ||
      !requiredEventTypes.every(
        (eventType) => typeof eventType === "string" && sport.event_types.includes(eventType),
      ) ||
      !["scoring_event.appended", "result.finalised", "result.corrected", "result.reopened"].every((action) =>
        sport.audit_actions.includes(action),
      ) ||
      !["scoring_event.appended", "result.finalised", "result.corrected", "result.reopened"].every((eventType) =>
        sport.outbox_event_types.includes(eventType),
      )
    ) {
      throw new Error(`Gate C C2 direct database oracle is incomplete for ${sportId}: ${JSON.stringify(sport)}`);
    }
  }
  if (
    database.sports.length !== gateCC2Sports.length ||
    database.downstream_conflicts.created !== 1 ||
    database.downstream_conflicts.acknowledged !== 1 ||
    database.downstream_conflicts.corrected_match_id.length < 1 ||
    database.downstream_conflicts.downstream_match_id.length < 1 ||
    database.downstream_conflicts.result_version !== 2 ||
    database.downstream_conflicts.reason !== "downstream_match_started" ||
    !database.downstream_conflicts.acknowledgement_actor_present ||
    database.downstream_conflicts.acknowledgement_reason !== "Reviewed against the corrected official result" ||
    !["result_conflict.created", "result_conflict.acknowledged"].every((action) =>
      database.downstream_conflicts.audit_actions.includes(action),
    ) ||
    !["result_conflict.created", "result_conflict.acknowledged"].every((eventType) =>
      database.downstream_conflicts.outbox_event_types.includes(eventType),
    )
  ) {
    throw new Error("Gate C C2 direct database oracle does not prove the retained downstream conflict");
  }
  if (
    database.multi_division.competition_id !== browser.multi_division.competition_id ||
    !sameArray(database.multi_division.division_ids, [
      browser.multi_division.primary_division_id,
      browser.multi_division.secondary_division_id,
    ]) ||
    !sameArray(database.multi_division.global_result_versions, [1, 2, 3, 4]) ||
    !sameArray(database.multi_division.primary_result_versions, [1, 3, 4]) ||
    !sameArray(database.multi_division.secondary_result_versions, [2]) ||
    database.multi_division.public_division_count !== 2 ||
    database.multi_division.cross_division_reference_count !== 0
  ) {
    throw new Error("Gate C C2 direct database oracle does not prove two-division public isolation");
  }
  return candidate as GateCC2SemanticReceipt;
}
