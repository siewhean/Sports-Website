export type ResultAuditEvent = Readonly<{
  eventId: string;
  sequence: number;
  type: string;
  side: "home" | "away" | null;
  participantLabel: string | null;
  reason: string | null;
  reversalTargetEventId: string | null;
  occurredAt: string;
  actorLabel: string;
  reversed: boolean;
  segmentNumber: number | null;
  manualTimeSeconds: number | null;
  unknownParticipant: boolean;
  reversible: boolean;
}>;

export type ResultAuditEntry = Readonly<{
  id: string;
  action: string;
  actorLabel: string;
  reason: string | null;
  occurredAt: string;
}>;

export type MatchScoringAudit = Readonly<{
  match: Readonly<{
    id: string;
    label: string;
    sportCode: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
    state: "scheduled" | "in_progress" | "finalised" | "corrected";
    homeName: string;
    awayName: string;
    homeScore: number;
    awayScore: number;
    aggregateVersion: number;
    resultVersion: number;
  }>;
  segments: readonly Readonly<{
    number: number;
    winner: "home" | "away" | null;
  }>[];
  events: readonly ResultAuditEvent[];
  audit: readonly ResultAuditEntry[];
  canManage: boolean;
}>;

export type ResultConflict = Readonly<{
  id: string;
  sourceMatchId: string;
  downstreamMatchId: string;
  reason: string;
  status: "open" | "acknowledged" | "resolved";
  revision: number;
  createdAt: string;
  acknowledgementReason: string | null;
  acknowledgedAt: string | null;
}>;

export type ResultMutationReceipt = Readonly<{
  matchId: string;
  aggregateVersion: number;
  throughSequence: number;
  duplicate: boolean;
  resultVersion: number;
  publicationVersion: number;
  conflicts: readonly ResultConflict[];
}>;

const sports = new Set(["canoe_polo", "badminton", "table_tennis", "volleyball", "basketball"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function iso(value: unknown): value is string {
  return text(value) && !Number.isNaN(Date.parse(value));
}

function side(value: unknown): value is "home" | "away" | null {
  return value === null || value === "home" || value === "away";
}

function parsePersistedEvent(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, [
      "event_id",
      "client_event_id",
      "aggregate_version",
      "event_type",
      "side",
      "participant_id",
      "unknown_participant",
      "segment_number",
      "manual_time_seconds",
      "reversal_target_event_id",
      "reason",
      "device_timestamp",
      "server_timestamp",
      "actor_type",
    ]) ||
    !text(item.event_id) ||
    !text(item.client_event_id) ||
    !integer(item.aggregate_version) ||
    !text(item.event_type) ||
    !side(item.side) ||
    !nullableText(item.participant_id) ||
    typeof item.unknown_participant !== "boolean" ||
    (item.segment_number !== null && !integer(item.segment_number)) ||
    (item.manual_time_seconds !== null && !integer(item.manual_time_seconds)) ||
    !nullableText(item.reversal_target_event_id) ||
    !nullableText(item.reason) ||
    (item.device_timestamp !== null && !iso(item.device_timestamp)) ||
    !iso(item.server_timestamp) ||
    !["access_pass", "account"].includes(String(item.actor_type))
  )
    return null;
  return item;
}

function parseAction(
  value: unknown,
  sequence: number,
  persisted: ReadonlyMap<string, Record<string, unknown>>,
): ResultAuditEvent | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, [
      "event_id",
      "client_event_id",
      "event_type",
      "label",
      "side",
      "participant_id",
      "segment_number",
      "score_delta",
      "occurred_at",
      "reversed",
      "reversible",
    ]) ||
    !text(item.event_id) ||
    !text(item.client_event_id) ||
    !text(item.event_type) ||
    !text(item.label) ||
    !side(item.side) ||
    !nullableText(item.participant_id) ||
    !integer(item.segment_number) ||
    !Number.isSafeInteger(item.score_delta) ||
    !iso(item.occurred_at) ||
    typeof item.reversed !== "boolean" ||
    typeof item.reversible !== "boolean"
  )
    return null;
  const source = persisted.get(item.event_id);
  if (!source || source.client_event_id !== item.client_event_id || source.event_type !== item.event_type) return null;
  return {
    eventId: item.event_id,
    sequence,
    type: item.event_type,
    side: item.side,
    participantLabel: item.participant_id,
    reason: source.reason as string | null,
    reversalTargetEventId: source.reversal_target_event_id as string | null,
    occurredAt: item.occurred_at,
    actorLabel: source.actor_type === "account" ? "Competition organiser" : "Scoring official",
    reversed: item.reversed,
    segmentNumber: item.segment_number,
    manualTimeSeconds: source.manual_time_seconds as number | null,
    unknownParticipant: source.unknown_participant as boolean,
    reversible: item.reversible,
  };
}

function rawHistoryEvent(source: Record<string, unknown>): ResultAuditEvent {
  return {
    eventId: source.event_id as string,
    sequence: source.aggregate_version as number,
    type: source.event_type as string,
    side: source.side as "home" | "away" | null,
    participantLabel: source.participant_id as string | null,
    reason: source.reason as string | null,
    reversalTargetEventId: source.reversal_target_event_id as string | null,
    occurredAt: source.server_timestamp as string,
    actorLabel: source.actor_type === "account" ? "Competition organiser" : "Scoring official",
    reversed: false,
    segmentNumber: source.segment_number as number | null,
    manualTimeSeconds: source.manual_time_seconds as number | null,
    unknownParticipant: source.unknown_participant as boolean,
    reversible: false,
  };
}

export function buildCanonicalReplacementCommand(
  event: ResultAuditEvent,
  input: Readonly<{
    clientEventId: string;
    occurredAt: string;
    side: "home" | "away";
    participantId: string;
  }>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    client_event_id: input.clientEventId,
    type: event.type,
    occurred_at: input.occurredAt,
    ...(event.segmentNumber !== null ? { segment_number: event.segmentNumber } : {}),
    ...(event.side ? { team_slot: input.side } : {}),
    ...(event.manualTimeSeconds !== null ? { manual_time_seconds: event.manualTimeSeconds } : {}),
    ...(event.unknownParticipant
      ? { unknown_participant: true }
      : event.participantLabel && input.participantId.trim()
        ? { participant_id: input.participantId.trim() }
        : {}),
  });
}

export function buildSegmentCompletionCommand(input: {
  clientEventId: string;
  occurredAt: string;
  sportCode: MatchScoringAudit["match"]["sportCode"];
  side: "home" | "away";
  segmentNumber: number;
}): Readonly<Record<string, unknown>> | null {
  const type =
    input.sportCode === "badminton" || input.sportCode === "table_tennis"
      ? "game_completion"
      : input.sportCode === "volleyball"
        ? "set_completion"
        : null;
  return type
    ? Object.freeze({
        client_event_id: input.clientEventId,
        type,
        occurred_at: input.occurredAt,
        team_slot: input.side,
        segment_number: input.segmentNumber,
      })
    : null;
}

export function buildAtomicSegmentWinnerCommands(input: {
  targets: readonly ResultAuditEvent[];
  replacementSide: "home" | "away";
  replacementParticipant: string;
  replacementPointCount: number;
  sportCode: MatchScoringAudit["match"]["sportCode"];
  reason: string;
  occurredAt: string;
  clientEventIds: readonly string[];
}): readonly Readonly<Record<string, unknown>>[] | null {
  const [first] = input.targets;
  const reason = input.reason.trim();
  const validTargets =
    first &&
    input.targets.length <= 10 &&
    new Set(input.targets.map((event) => event.eventId)).size === input.targets.length &&
    first.type === "point" &&
    first.side !== null &&
    first.side !== input.replacementSide &&
    first.segmentNumber !== null &&
    input.targets.every(
      (event) =>
        event.type === first.type &&
        event.side === first.side &&
        event.segmentNumber === first.segmentNumber &&
        event.reversible &&
        !event.reversed,
    );
  const expectedCommandCount = input.targets.length + input.replacementPointCount + 1;
  if (
    !validTargets ||
    !Number.isInteger(input.replacementPointCount) ||
    input.replacementPointCount < 1 ||
    input.replacementPointCount > 10 ||
    reason.length < 3 ||
    input.clientEventIds.length !== expectedCommandCount
  ) {
    return null;
  }
  const commands: Readonly<Record<string, unknown>>[] = input.targets.map((event, index) =>
    Object.freeze({
      client_event_id: input.clientEventIds[index],
      type: "reversal",
      occurred_at: input.occurredAt,
      reversal_target_event_id: event.eventId,
      reason,
    }),
  );
  for (let index = 0; index < input.replacementPointCount; index += 1) {
    commands.push(
      buildCanonicalReplacementCommand(first, {
        clientEventId: input.clientEventIds[input.targets.length + index]!,
        occurredAt: input.occurredAt,
        side: input.replacementSide,
        participantId: input.replacementParticipant,
      }),
    );
  }
  const completion = buildSegmentCompletionCommand({
    clientEventId: input.clientEventIds.at(-1)!,
    occurredAt: input.occurredAt,
    sportCode: input.sportCode,
    side: input.replacementSide,
    segmentNumber: first.segmentNumber,
  });
  if (!completion) return null;
  commands.push(completion);
  return Object.freeze(commands);
}

function parseAuditEntry(value: unknown): ResultAuditEntry | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, ["id", "occurred_at", "action", "actor_type", "reason", "metadata"]) ||
    !text(item.id) ||
    !text(item.action) ||
    !["access_pass", "account", "system"].includes(String(item.actor_type)) ||
    !nullableText(item.reason) ||
    !iso(item.occurred_at) ||
    !record(item.metadata)
  )
    return null;
  return {
    id: item.id,
    action: item.action,
    actorLabel:
      item.actor_type === "account"
        ? "Competition organiser"
        : item.actor_type === "access_pass"
          ? "Scoring official"
          : "Matchday system",
    reason: item.reason,
    occurredAt: item.occurred_at,
  };
}

export function parseMatchScoringAudit(value: unknown): MatchScoringAudit | null {
  const item = record(value);
  const match = record(item?.match);
  const home = record(match?.home);
  const away = record(match?.away);
  const competition = record(item?.competition);
  const sport = record(item?.sport);
  const score = record(item?.score);
  const totalPoints = record(score?.total_points);
  const segmentWins = record(score?.segment_wins);
  const result = item?.result === null ? null : record(item?.result);
  if (
    !item ||
    !exact(item, [
      "match",
      "competition",
      "sport",
      "score",
      "result",
      "events",
      "audit",
      "conflicts",
      "aggregate_version",
      "through_sequence",
      "permission",
    ]) ||
    !match ||
    !exact(match, ["id", "code", "state", "home", "away"]) ||
    !home ||
    !exact(home, ["id", "name"]) ||
    !away ||
    !exact(away, ["id", "name"]) ||
    !competition ||
    !exact(competition, ["id", "sport_code"]) ||
    !sport ||
    !exact(sport, ["pack_version", "settings"]) ||
    !score ||
    !exact(score, [
      "home",
      "away",
      "lifecycle",
      "current_segment",
      "total_points",
      "segment_wins",
      "segments",
      "actions",
      "conflicts",
    ]) ||
    !totalPoints ||
    !exact(totalPoints, ["home", "away"]) ||
    !segmentWins ||
    !exact(segmentWins, ["home", "away"]) ||
    !text(match.id) ||
    !text(match.code) ||
    !["scheduled", "in_progress", "finalised", "corrected"].includes(String(match.state)) ||
    !text(home.id) ||
    !text(home.name) ||
    !text(away.id) ||
    !text(away.name) ||
    !text(competition.id) ||
    !sports.has(String(competition.sport_code)) ||
    !text(sport.pack_version) ||
    !record(sport.settings) ||
    !integer(score.home) ||
    !integer(score.away) ||
    !["not_started", "in_progress", "finalised"].includes(String(score.lifecycle)) ||
    !integer(score.current_segment) ||
    !integer(totalPoints.home) ||
    !integer(totalPoints.away) ||
    !integer(segmentWins.home) ||
    !integer(segmentWins.away) ||
    !Array.isArray(score.segments) ||
    !score.segments.every((segment) => {
      const row = record(segment);
      return (
        row &&
        exact(row, ["number", "home", "away", "completed", "winner"]) &&
        integer(row.number) &&
        integer(row.home) &&
        integer(row.away) &&
        typeof row.completed === "boolean" &&
        side(row.winner)
      );
    }) ||
    !Array.isArray(score.actions) ||
    !Array.isArray(score.conflicts) ||
    !score.conflicts.every((conflict) => {
      const row = record(conflict);
      return (
        row &&
        exact(row, ["code", "segment_number", "target_event_id", "later_segment_numbers"]) &&
        row.code === "segment_reopened_after_reversal" &&
        integer(row.segment_number) &&
        text(row.target_event_id) &&
        Array.isArray(row.later_segment_numbers) &&
        row.later_segment_numbers.every(integer)
      );
    }) ||
    (result !== null &&
      (!exact(result, ["result_version", "updated_at"]) ||
        !integer(result.result_version) ||
        !iso(result.updated_at))) ||
    !Array.isArray(item.events) ||
    !Array.isArray(item.audit) ||
    !Array.isArray(item.conflicts) ||
    !integer(item.aggregate_version) ||
    !integer(item.through_sequence) ||
    !["read", "write"].includes(String(item.permission))
  )
    return null;
  const persistedEvents = item.events.map(parsePersistedEvent);
  if (persistedEvents.some((event) => !event)) return null;
  const persisted = new Map(
    (persistedEvents as Record<string, unknown>[]).map((event) => [String(event.event_id), event]),
  );
  const actions = score.actions.map((action, index) => parseAction(action, index + 1, persisted));
  const audit = item.audit.map(parseAuditEntry);
  const conflicts = parseResultConflicts(item.conflicts);
  if (actions.some((event) => !event) || audit.some((entry) => !entry) || !conflicts) return null;
  const actionById = new Map((actions as ResultAuditEvent[]).map((event) => [event.eventId, event]));
  const events = (persistedEvents as Record<string, unknown>[])
    .map((source) => {
      const raw = rawHistoryEvent(source);
      const action = actionById.get(raw.eventId);
      return action ? { ...raw, reversed: action.reversed, reversible: action.reversible } : raw;
    })
    .toSorted((left, right) => left.sequence - right.sequence);
  return {
    match: {
      id: match.id,
      label: match.code,
      sportCode: competition.sport_code as MatchScoringAudit["match"]["sportCode"],
      state: match.state as MatchScoringAudit["match"]["state"],
      homeName: home.name,
      awayName: away.name,
      homeScore: score.home,
      awayScore: score.away,
      aggregateVersion: item.aggregate_version,
      resultVersion: result ? Number(result.result_version) : 0,
    },
    segments: (score.segments as Record<string, unknown>[]).map((segment) => ({
      number: segment.number as number,
      winner: segment.winner as "home" | "away" | null,
    })),
    events: events as ResultAuditEvent[],
    audit: audit as ResultAuditEntry[],
    canManage: item.permission === "write",
  };
}

function validConflictDetail(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item &&
    exact(item, ["affected_slot", "previous_entry_id", "proposed_entry_id"]) &&
    side(item.affected_slot) &&
    nullableText(item.previous_entry_id) &&
    nullableText(item.proposed_entry_id),
  );
}

export function parseResultConflict(value: unknown): ResultConflict | null {
  const item = record(value);
  const baseKeys = [
    "id",
    "corrected_match_id",
    "downstream_match_id",
    "result_version",
    "reason",
    "status",
    "detail",
    "created_at",
    "acknowledged_at",
    "acknowledged_by_account_id",
    "acknowledgement_reason",
  ];
  const hasAcknowledgementReceipt = Boolean(item && "acknowledgement_client_event_id" in item);
  if (
    !item ||
    !exact(item, hasAcknowledgementReceipt ? [...baseKeys, "acknowledgement_client_event_id"] : baseKeys) ||
    !text(item.id) ||
    !text(item.corrected_match_id) ||
    !text(item.downstream_match_id) ||
    !integer(item.result_version) ||
    !text(item.reason) ||
    !["open", "acknowledged", "resolved"].includes(String(item.status)) ||
    !validConflictDetail(item.detail) ||
    !iso(item.created_at) ||
    !nullableText(item.acknowledgement_reason) ||
    (item.acknowledged_at !== null && !iso(item.acknowledged_at)) ||
    !nullableText(item.acknowledged_by_account_id) ||
    (hasAcknowledgementReceipt && !text(item.acknowledgement_client_event_id))
  )
    return null;
  return {
    id: item.id,
    sourceMatchId: item.corrected_match_id,
    downstreamMatchId: item.downstream_match_id,
    reason: item.reason,
    status: item.status as ResultConflict["status"],
    revision: item.result_version,
    createdAt: item.created_at,
    acknowledgementReason: item.acknowledgement_reason,
    acknowledgedAt: item.acknowledged_at,
  };
}

export function parseResultConflicts(value: unknown): readonly ResultConflict[] | null {
  if (!Array.isArray(value)) return null;
  const conflicts = value.map(parseResultConflict);
  return conflicts.some((conflict) => !conflict) ? null : (conflicts as ResultConflict[]);
}

export function parseResultMutationReceipt(value: unknown): ResultMutationReceipt | null {
  const item = record(value);
  if (
    !item ||
    !exact(item, [
      "match_id",
      "aggregate_version",
      "through_sequence",
      "duplicate",
      "result_version",
      "publication_version",
      "conflicts",
    ]) ||
    !text(item.match_id) ||
    !integer(item.aggregate_version) ||
    !integer(item.through_sequence) ||
    typeof item.duplicate !== "boolean" ||
    !integer(item.result_version) ||
    !integer(item.publication_version)
  )
    return null;
  const conflicts = parseResultConflicts(item.conflicts);
  return conflicts
    ? {
        matchId: item.match_id,
        aggregateVersion: item.aggregate_version,
        throughSequence: item.through_sequence,
        duplicate: item.duplicate,
        resultVersion: item.result_version,
        publicationVersion: item.publication_version,
        conflicts,
      }
    : null;
}

export const gateCResultsCopy = {
  title: "Match corrections and audit",
  intro: "Reopen and correct one completed match without deleting its original scoring history.",
  choose: "Choose a completed match",
  chooseBody: "Open a completed match from the schedule, or select one here to review its immutable history.",
  status: "Match state",
  score: "Published score",
  reopen: "Reopen for correction",
  correct: "Reverse scoring event",
  finalise: "Apply correction and publish result",
  reason: "Correction reason",
  reasonHint: "Record the verified source and why the published result must change.",
  selectEvent: "Event to reverse",
  cancel: "Cancel",
  confirmReopen: "Reopen match",
  confirmCorrection: "Publish correction",
  audit: "Immutable match audit",
  eventHistory: "Scoring event history",
  conflicts: "Critical downstream conflicts",
  noConflicts: "No downstream conflicts require acknowledgement.",
  conflictWarning:
    "The corrected result is public, but this downstream assignment was protected. The published schedule remains unchanged until C4 repair and explicit publication.",
  acknowledge: "Acknowledge conflict",
  acknowledgeReason: "Acknowledgement reason",
  acknowledgeAction: "Record acknowledgement",
  refreshed: "Match audit refreshed.",
  reopened: "Match reopened. Its published history remains preserved.",
  corrected: "Correction finalised and the corrected result published.",
  acknowledged: "Conflict acknowledged. Schedule repair remains pending.",
  unavailable: "Match correction controls are temporarily unavailable. No result was changed.",
  malformed: "The results service returned an invalid match history.",
  readOnly: "You can inspect this history, but only an organiser may change it.",
  noReversible: "No unreversed scoring event is available.",
  conflictRefresh: "This match changed elsewhere. Refresh its audit before trying again.",
  eyebrow: "Correction control",
  refresh: "Refresh audit",
  versus: "vs",
  reversed: "reversed",
  downstreamMatch: "Downstream match",
  scoringAuditUnavailable: "The match audit is unavailable",
  scoringAuditInvalid: "The match audit response was invalid",
  conflictsUnavailable: "Result conflicts are unavailable",
  conflictsInvalid: "The result-conflict response was invalid",
  reopenInvalid: "A valid reason and current version are required",
  correctionInvalid: "Between one and 25 correction events are required",
  correctionEventInvalid: "Every correction event must use the canonical schema",
  acknowledgementInvalid: "An acknowledgement reason and current revision are required",
  conflictsLoading: "Loading critical downstream conflicts.",
  conflictsError: "Critical downstream conflicts could not be loaded. No conflict was dismissed.",
  retryConflicts: "Retry conflict list",
  addReplacement: "Add a replacement of this validated action",
  replacementSide: "Replacement side",
  replacementParticipant: "Replacement participant name",
  replacementParticipantHint: "Use the participant name recorded in the verified scoring source, when required.",
  flipSegmentWinner: "Change this segment winner atomically",
  atomicCorrection: "Atomic segment-winner correction",
  additionalReversals: "Additional scoring events to reverse",
  replacementPoints: "Opposing replacement points",
  correctionReview: "Correction command review",
  reversalsReview: "Scoring events reversed",
  replacementsReview: "Opposing scoring events added",
  completionReview: "Segment completion added",
  completionGame: "game completion",
  completionSet: "set completion",
  eventId: "Server event",
  reversalTarget: "Reverses",
  manualTime: "Manual event time",
  matchEvent: "match",
  noParticipant: "No participant",
} as const;

export const gateCResultsMachine = {
  post: "POST" as const,
  json: "application/json" as const,
  dialog: "dialog" as const,
  home: "home" as const,
  away: "away" as const,
  canoePolo: "canoe_polo" as const,
  scheduled: "scheduled" as const,
  inProgress: "in_progress" as const,
  finalised: "finalised" as const,
  corrected: "corrected" as const,
  matchFinalised: "match_finalised" as const,
  matchReopened: "match_reopened" as const,
  reversal: "reversal" as const,
  open: "open" as const,
  reopen: "reopen" as const,
  correction: "correction" as const,
  matchQuery: "match" as const,
  loading: "loading" as const,
  ready: "ready" as const,
  error: "error" as const,
  loadPage: "page" as const,
  loadDialog: "dialog" as const,
  correctionCommandInvalid: "CORRECTION_COMMAND_INVALID",
  correctionEventInvalid: "CORRECTION_EVENT_INVALID",
  reopenCommandInvalid: "REOPEN_COMMAND_INVALID",
  scoringAuditUnavailable: "SCORING_AUDIT_UNAVAILABLE",
  scoringAuditInvalid: "SCORING_AUDIT_INVALID",
  conflictsUnavailable: "RESULT_CONFLICTS_UNAVAILABLE",
  conflictsInvalid: "RESULT_CONFLICTS_INVALID",
  acknowledgementInvalid: "ACKNOWLEDGEMENT_REASON_INVALID",
  commandKeys: [
    "client_event_id",
    "type",
    "occurred_at",
    "team_slot",
    "participant_id",
    "unknown_participant",
    "segment_number",
    "manual_time_seconds",
    "reversal_target_event_id",
    "reason",
  ] as const,
  correctionBodyKeys: ["clientEventId", "reason", "expectedAggregateVersion", "events"] as const,
  reopenBodyKeys: ["clientEventId", "reason", "expectedAggregateVersion"] as const,
  acknowledgementBodyKeys: ["clientEventId", "reason", "expectedRevision"] as const,
} as const;
