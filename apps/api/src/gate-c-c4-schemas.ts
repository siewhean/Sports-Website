import { Type, type TSchema } from "@sinclair/typebox";

export const gateCC4Id = Type.String({ format: "uuid" });
export const gateCC4Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const gateCC4DateTime = Type.String({ format: "date-time" });

export function gateCC4Strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

// Standings and brackets are sport-pack-owned JSON extension points. Their
// enclosing C4 response objects remain closed; this leaf preserves the
// established contract without introducing ambiguous recursive serializer refs.
const gateCC4JsonObject = Type.Object({}, { additionalProperties: true });
const gateCC4Slot = Type.Union([Type.Literal("home"), Type.Literal("away")]);
const gateCC4Decision = Type.Union([
  Type.Literal("accept_proposed"),
  Type.Literal("keep_current"),
  Type.Literal("set_manual_entry"),
  Type.Literal("leave_protected"),
]);
const gateCC4Action = Type.Union([
  Type.Literal("no_change"),
  Type.Literal("automatic_update"),
  Type.Literal("protected_started_match"),
  Type.Literal("protected_finalised_match"),
  Type.Literal("protected_manual_slot"),
  Type.Literal("requires_organiser_decision"),
]);
const gateCC4RevisionStatus = Type.Union([
  Type.Literal("draft"),
  Type.Literal("ready"),
  Type.Literal("published"),
  Type.Literal("abandoned"),
]);

const gateCC4DependencyStep = gateCC4Strict({
  source_match_id: gateCC4Id,
  downstream_match_id: gateCC4Id,
  slot: gateCC4Slot,
  outcome: Type.Union([Type.Literal("winner"), Type.Literal("loser")]),
});

const gateCC4AnalysisAction = gateCC4Strict({
  match_id: gateCC4Id,
  division_id: gateCC4Id,
  slot: gateCC4Slot,
  current_entry_id: Type.Union([gateCC4Id, Type.Null()]),
  proposed_entry_id: Type.Union([gateCC4Id, Type.Null()]),
  match_state: Type.Union([
    Type.Literal("pending"),
    Type.Literal("ready"),
    Type.Literal("in_progress"),
    Type.Literal("final"),
    Type.Literal("corrected"),
  ]),
  control: Type.Union([Type.Literal("automatic"), Type.Literal("manual")]),
  action: gateCC4Action,
  reason: Type.String({ minLength: 3, maxLength: 1_000 }),
  dependency_path: Type.Array(gateCC4DependencyStep),
});

const gateCC4Analysis = gateCC4Strict({
  schema_version: Type.Literal(1),
  competition_id: gateCC4Id,
  corrected_match_id: gateCC4Id,
  source_result_version: Type.Integer({ minimum: 1 }),
  source_schedule_version: Type.Integer({ minimum: 0 }),
  affected_division_ids: Type.Array(gateCC4Id),
  actions: Type.Array(gateCC4AnalysisAction),
  analysis_fingerprint_input: Type.String({ minLength: 2 }),
});

const gateCC4RepairCase = gateCC4Strict({
  repair_id: gateCC4Id,
  competition_id: gateCC4Id,
  corrected_match_id: gateCC4Id,
  source_result_version: Type.Integer({ minimum: 1 }),
  source_schedule_version: Type.Integer({ minimum: 0 }),
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("drafted"),
    Type.Literal("published"),
    Type.Literal("abandoned"),
  ]),
  analysis: gateCC4Analysis,
  created_at: gateCC4DateTime,
  created_by_account_id: gateCC4Id,
});

export const gateCC4RevisionView = gateCC4Strict({
  repair_revision_id: gateCC4Id,
  repair_id: gateCC4Id,
  revision: Type.Integer({ minimum: 1 }),
  status: gateCC4RevisionStatus,
  source_result_version: Type.Integer({ minimum: 1 }),
  source_schedule_version: Type.Integer({ minimum: 0 }),
  analysis_fingerprint: gateCC4Sha256,
  analysis_fingerprint_input: Type.String({ minLength: 2 }),
  created_at: gateCC4DateTime,
  created_by_account_id: gateCC4Id,
});

const gateCC4ScheduleAdjustment = gateCC4Strict({
  match_id: gateCC4Id,
  division_id: gateCC4Id,
  starts_at: Type.Union([gateCC4DateTime, Type.Null()]),
  ends_at: Type.Union([gateCC4DateTime, Type.Null()]),
  playing_area_id: Type.Union([gateCC4Id, Type.Null()]),
  reason: Type.String({ minLength: 3, maxLength: 1_000 }),
});

const gateCC4ActionView = gateCC4Strict({
  repair_action_id: gateCC4Id,
  repair_revision_id: gateCC4Id,
  ordinal: Type.Integer({ minimum: 1 }),
  match_id: gateCC4Id,
  division_id: gateCC4Id,
  slot: gateCC4Slot,
  source_action: gateCC4Action,
  decision: Type.Union([gateCC4Decision, Type.Null()]),
  current_entry_id: Type.Union([gateCC4Id, Type.Null()]),
  proposed_entry_id: Type.Union([gateCC4Id, Type.Null()]),
  resolved_entry_id: Type.Union([gateCC4Id, Type.Null()]),
  reason: Type.String({ minLength: 3, maxLength: 1_000 }),
  dependency_path: Type.Array(gateCC4DependencyStep),
  created_at: gateCC4DateTime,
  current_entry_name: Type.Union([Type.String(), Type.Null()]),
  proposed_entry_name: Type.Union([Type.String(), Type.Null()]),
  resolved_entry_name: Type.Union([Type.String(), Type.Null()]),
  adjustment: Type.Union([gateCC4ScheduleAdjustment, Type.Null()]),
});

const gateCC4AuditEntry = gateCC4Strict({
  occurred_at: gateCC4DateTime,
  actor_account_id: Type.Union([gateCC4Id, Type.Null()]),
  action: Type.String({ minLength: 1 }),
  target_type: Type.String({ minLength: 1 }),
  target_id: Type.String({ minLength: 1 }),
  reason: Type.Union([Type.String(), Type.Null()]),
});

export const gateCC4WorkspaceResponse = gateCC4Strict({
  repair: gateCC4RepairCase,
  latest_revision: Type.Union([gateCC4RevisionView, Type.Null()]),
  actions: Type.Array(gateCC4ActionView),
  unresolved_action_keys: Type.Array(Type.String({ minLength: 1 })),
  publication_ready: Type.Boolean(),
  current_result_version: Type.Integer({ minimum: 0 }),
  published_schedule_version: Type.Integer({ minimum: 0 }),
  public_projection_versions: Type.Record(gateCC4Id, Type.Integer({ minimum: 1 })),
  audit: Type.Array(gateCC4AuditEntry),
});

export const gateCC4RevisionCreateResponse = gateCC4Strict({
  revision: gateCC4RevisionView,
  actions: Type.Array(gateCC4ActionView),
  unresolved_action_keys: Type.Array(Type.String({ minLength: 1 })),
  publication_ready: Type.Boolean(),
});

export const gateCC4PublicationReceipt = gateCC4Strict({
  competition_id: gateCC4Id,
  repair_id: gateCC4Id,
  repair_revision_id: gateCC4Id,
  schedule_version: Type.Integer({ minimum: 1 }),
  result_version: Type.Integer({ minimum: 1 }),
  projection_version: Type.Integer({ minimum: 1 }),
  schedule_revision_id: gateCC4Id,
  analysis_fingerprint: gateCC4Sha256,
  duplicate: Type.Boolean(),
  published_at: gateCC4DateTime,
});

export const gateCC4AbandonReceipt = gateCC4Strict({
  repair_id: gateCC4Id,
  repair_revision_id: gateCC4Id,
  revision: Type.Integer({ minimum: 1 }),
  status: Type.Literal("abandoned"),
  abandoned_at: gateCC4DateTime,
});

const gateCC4PublicParticipant = gateCC4Strict({ id: Type.Union([gateCC4Id, Type.Null()]), name: Type.String() });
const gateCC4PublicSchedule = gateCC4Strict({
  id: gateCC4Id,
  code: Type.String(),
  stage: Type.String(),
  home: gateCC4PublicParticipant,
  away: gateCC4PublicParticipant,
  starts_at: gateCC4DateTime,
  ends_at: gateCC4DateTime,
  area: gateCC4Strict({ id: gateCC4Id, name: Type.String() }),
});
const gateCC4PublicResult = gateCC4Strict({
  id: gateCC4Id,
  code: Type.String(),
  stage: Type.String(),
  home: gateCC4PublicParticipant,
  away: gateCC4PublicParticipant,
  home_score: Type.Integer({ minimum: 0 }),
  away_score: Type.Integer({ minimum: 0 }),
  state: Type.Union([Type.Literal("final"), Type.Literal("corrected")]),
  updated_at: gateCC4DateTime,
});
const gateCC4PublicDivision = gateCC4Strict({
  division: gateCC4Strict({ id: gateCC4Id, name: Type.String() }),
  schedule: Type.Array(gateCC4PublicSchedule),
  results: Type.Array(gateCC4PublicResult),
  standings: Type.Union([gateCC4JsonObject, Type.Null()]),
  bracket: Type.Union([gateCC4JsonObject, Type.Null()]),
});
const gateCC4Freshness = gateCC4Strict({
  division_id: gateCC4Id,
  schedule_version: Type.Integer({ minimum: 0 }),
  result_version: Type.Integer({ minimum: 0 }),
  projection_version: Type.Integer({ minimum: 1 }),
  generated_at: gateCC4DateTime,
  source_updated_at: gateCC4DateTime,
  etag: Type.String({ pattern: "^[A-Za-z0-9._:-]{1,250}$" }),
});

export const gateCC4PublicTruthResponse = gateCC4Strict({
  competition: gateCC4Strict({
    id: gateCC4Id,
    name: Type.String(),
    slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 120 }),
    sport_code: Type.Union([
      Type.Literal("canoe_polo"),
      Type.Literal("badminton"),
      Type.Literal("table_tennis"),
      Type.Literal("volleyball"),
      Type.Literal("basketball"),
    ]),
    timezone: Type.String(),
    starts_on: Type.String({ format: "date" }),
    ends_on: Type.String({ format: "date" }),
    status: Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("archived")]),
  }),
  divisions: Type.Array(gateCC4PublicDivision, { minItems: 1 }),
  division: gateCC4Strict({ id: gateCC4Id, name: Type.String() }),
  publication: gateCC4Strict({
    schedule_version: Type.Integer({ minimum: 0 }),
    result_version: Type.Integer({ minimum: 0 }),
  }),
  schedule: Type.Array(gateCC4PublicSchedule),
  results: Type.Array(gateCC4PublicResult),
  standings: Type.Union([gateCC4JsonObject, Type.Null()]),
  bracket: Type.Union([gateCC4JsonObject, Type.Null()]),
  last_updated_at: gateCC4DateTime,
  freshness: gateCC4Freshness,
});

export const gateCC4PdfBinaryResponse = Type.String({ format: "binary", contentMediaType: "application/pdf" });
