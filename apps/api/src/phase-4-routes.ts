import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { Phase4Runtime } from "./phase-4-runtime.js";

const Id = Type.String({ format: "uuid" });
const IdempotencyKey = Type.String({ pattern: "^[A-Za-z0-9._:-]{8,200}$" });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Json = Type.Unknown();
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const MutationHeaders = Type.Object(
  { origin: Type.String({ minLength: 1 }), "x-csrf-token": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
const MutationResponses = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse, 503: ErrorResponse };
const ReadResponses = { 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

const Sport = Type.Union([
  Type.Literal("canoe_polo"),
  Type.Literal("badminton"),
  Type.Literal("table_tennis"),
  Type.Literal("volleyball"),
  Type.Literal("basketball"),
]);
const Objective = Type.Union([Type.Literal("fastest"), Type.Literal("balanced"), Type.Literal("rest_focused")]);
const ConstraintMode = Type.Union([Type.Literal("required"), Type.Literal("preferred"), Type.Literal("ignored")]);

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

function setting<T extends TSchema>(value: T) {
  return strict({ mode: ConstraintMode, value, weight: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })) });
}

const Interval = strict({ start_epoch_ms: Type.Integer({ minimum: 0 }), end_epoch_ms: Type.Integer({ minimum: 1 }) });
const Constraints = strict({
  minimum_rest: setting(strict({ minutes: Type.Integer({ minimum: 0, maximum: 1440 }) })),
  maximum_matches_per_day: setting(strict({ matches: Type.Integer({ minimum: 1, maximum: 64 }) })),
  preferred_final_time: setting(
    strict({
      target_start_epoch_ms: Type.Integer({ minimum: 0 }),
      tolerance_minutes: Type.Integer({ minimum: 0, maximum: 1440 }),
    }),
  ),
  entry_unavailable: setting(strict({ by_entry_id: Type.Record(Id, Type.Array(Interval, { maxItems: 512 })) })),
  official_availability: setting(strict({ by_official_id: Type.Record(Id, Type.Array(Interval, { maxItems: 512 })) })),
  featured_playing_area: setting(strict({ area_id: Id, match_ids: Type.Array(Id, { maxItems: 1_128, uniqueItems: true }) })),
  avoid_consecutive_matches: setting(strict({ minutes: Type.Integer({ minimum: 0, maximum: 1440 }) })),
  balance_early_matches: setting(strict({ before_local_time: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }) })),
  balance_late_matches: setting(strict({ at_or_after_local_time: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }) })),
  keep_division_together: setting(strict({ maximum_area_count: Type.Integer({ minimum: 1, maximum: 64 }) })),
  preserve_existing_schedule: setting(
    strict({
      maximum_shift_minutes: Type.Integer({ minimum: 0, maximum: 100_800 }),
      by_match_id: Type.Record(
        Id,
        strict({ area_id: Id, start_epoch_ms: Type.Integer({ minimum: 0 }) }),
      ),
    }),
  ),
});

const ParticipantSource = Type.Union([
  strict({ type: Type.Literal("entry_seed"), seed: Type.Integer({ minimum: 1, maximum: 48 }) }),
  strict({
    type: Type.Literal("stage_rank"),
    stageId: Type.String({ minLength: 1, maxLength: 128 }),
    groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    rank: Type.Integer({ minimum: 1, maximum: 48 }),
  }),
  strict({ type: Type.Literal("manual_qualifier"), qualifierId: Type.String({ minLength: 1, maxLength: 128 }), stageId: Type.String({ minLength: 1, maxLength: 128 }) }),
  strict({ type: Type.Literal("winner"), matchId: Type.String({ minLength: 1, maxLength: 128 }) }),
  strict({ type: Type.Literal("loser"), matchId: Type.String({ minLength: 1, maxLength: 128 }) }),
]);
const Stage = strict({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 160 }),
  kind: Type.Union([
    Type.Literal("round_robin"),
    Type.Literal("group"),
    Type.Literal("single_elimination"),
    Type.Literal("placement"),
    Type.Literal("consolation"),
    Type.Literal("classification"),
    Type.Literal("bronze"),
  ]),
  order: Type.Integer({ minimum: 1, maximum: 128 }),
  groupIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 48, uniqueItems: true }),
  groupSize: Type.Union([Type.Null(), Type.Integer({ minimum: 2, maximum: 48 })]),
  outputRanks: Type.Integer({ minimum: 1, maximum: 48 }),
  matchIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 1_128, uniqueItems: true }),
  repetitions: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })),
  qualificationPositions: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 48 }), { uniqueItems: true })),
  additionalQualifiers: Type.Optional(
    Type.Array(
      strict({
        method: Type.Union([Type.Literal("best_across_groups"), Type.Literal("bottom_from_each_group"), Type.Literal("manual")]),
        count: Type.Integer({ minimum: 1, maximum: 48 }),
        destinationStageId: Type.String({ minLength: 1, maxLength: 128 }),
      }),
      { maxItems: 48 },
    ),
  ),
  destinationStageIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { uniqueItems: true })),
  seeding: Type.Optional(Type.Union([Type.Literal("seeded"), Type.Literal("snake"), Type.Literal("random"), Type.Literal("manual")])),
  placementRule: Type.Optional(
    strict({
      coverage: Type.Union([Type.Literal("champion_only"), Type.Literal("podium"), Type.Literal("full"), Type.Literal("custom")]),
      positions: Type.Array(Type.Integer({ minimum: 1, maximum: 48 }), { uniqueItems: true }),
    }),
  ),
  carriedResults: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("head_to_head"), Type.Literal("all")])),
});
const FormatDocument = strict({
  schema_version: Type.Literal(1),
  graph: strict({
    id: Type.String({ minLength: 1, maxLength: 128 }),
    schemaVersion: Type.Literal(1),
    entryCount: Type.Integer({ minimum: 2, maximum: 48 }),
    stages: Type.Array(Stage, { minItems: 1, maxItems: 64 }),
    matches: Type.Array(
      strict({
        id: Type.String({ minLength: 1, maxLength: 128 }),
        stageId: Type.String({ minLength: 1, maxLength: 128 }),
        poolId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        round: Type.Integer({ minimum: 1, maximum: 128 }),
        order: Type.Integer({ minimum: 1, maximum: 1_128 }),
        purpose: Type.Union([
          Type.Literal("pool"),
          Type.Literal("progression"),
          Type.Literal("championship"),
          Type.Literal("placement"),
          Type.Literal("classification"),
        ]),
        home: ParticipantSource,
        away: ParticipantSource,
      }),
      { minItems: 1, maxItems: 1_128 },
    ),
    terminalMatchIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 1_128, uniqueItems: true }),
  }),
  layout: strict({
    schema_version: Type.Literal(1),
    stage_positions: Type.Array(
      strict({ stage_id: Type.String({ minLength: 1, maxLength: 128 }), x: Type.Number(), y: Type.Number() }),
      { maxItems: 64 },
    ),
  }),
});

const SetupStep = Type.Union([
  "basics",
  "capacity",
  "settings",
  "entries",
  "format_preferences",
  "format_recommendations",
  "schedule_review",
  "review_publish",
].map((value) => Type.Literal(value)));
const SettingsReference = strict({
  competition_id: Id,
  scope: Type.Union([Type.Literal("competition"), Type.Literal("division")]),
  division_id: Type.Union([Type.Null(), Id]),
  settings_revision: Type.Integer({ minimum: 1 }),
  mode: Type.Union([Type.Literal("recommended"), Type.Literal("customised")]),
  pack_schema_version: Type.Integer({ minimum: 1 }),
  pack_version: Type.String({ minLength: 1, maxLength: 100 }),
  pack_definition_hash: Hash,
});
const SettingsPointer = strict({
  scope: Type.Union([Type.Literal("competition"), Type.Literal("division")]),
  division_id: Type.Union([Type.Null(), Id]),
  settings_revision: Type.Integer({ minimum: 1 }),
  pack_definition_hash: Hash,
});
const Recommendation = strict({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  format_revision_id: Id,
  format_definition_hash: Hash,
  name: Type.String({ minLength: 1, maxLength: 160 }),
  structure: Type.String({ minLength: 1, maxLength: 500 }),
  advantage: Type.String({ minLength: 1, maxLength: 500 }),
  match_count: Type.Integer({ minimum: 1 }),
  minimum_matches_per_entry: Type.Integer({ minimum: 1 }),
  capacity_status: Type.Union([Type.Literal("fits"), Type.Literal("tight"), Type.Literal("requires_changes")]),
  scheduling_status: Type.Union([Type.Literal("feasible"), Type.Literal("infeasible"), Type.Literal("not_checked")]),
  warning_codes: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { uniqueItems: true, maxItems: 100 }),
});
const ReviewBase = {
  selected_format_revision_id: Id,
  selected_schedule_result_hash: Hash,
  capacity_revision: Type.Integer({ minimum: 1 }),
  settings_references: Type.Array(SettingsPointer, { maxItems: 100 }),
  acknowledged_warning_codes: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { uniqueItems: true, maxItems: 100 }),
};
const ReviewSelection = Type.Union([
  strict({ ...ReviewBase, publication_status: Type.Union([Type.Literal("not_requested"), Type.Literal("publishing"), Type.Literal("failed")]), published_schedule_revision_id: Type.Null() }),
  strict({ ...ReviewBase, publication_status: Type.Literal("published"), published_schedule_revision_id: Id }),
]);
const SetupStepValue = Type.Union([
  strict({
    step_id: Type.Literal("basics"),
    value: strict({
      name: Type.String({ minLength: 1, maxLength: 160 }), sport_code: Sport,
      location: strict({ venue: Type.String({ minLength: 1, maxLength: 240 }), address: Type.String({ minLength: 1, maxLength: 500 }), locality: Type.Union([Type.Null(), Type.String({ maxLength: 160 })]), country_code: Type.String({ pattern: "^[A-Z]{2}$" }) }),
      starts_on: Type.String({ format: "date" }), ends_on: Type.String({ format: "date" }), time_zone: Type.String({ minLength: 1, maxLength: 100 }), locale: Type.String({ minLength: 2, maxLength: 35 }),
      entry_count: Type.Integer({ minimum: 1, maximum: 10_000 }), division_count: Type.Integer({ minimum: 1, maximum: 1_000 }), entry_count_status: Type.Union([Type.Literal("confirmed"), Type.Literal("estimated")]),
    }),
  }),
  strict({
    step_id: Type.Literal("capacity"),
    value: strict({
      kind: Type.Literal("phase3_capacity_revision"), competition_id: Id, revision: Type.Integer({ minimum: 1 }), time_zone: Type.String({ minLength: 1, maxLength: 100 }), area_ids: Type.Array(Id, { uniqueItems: true, maxItems: 100 }), source_hash: Hash,
      effective: strict({ slotMinutes: Type.Integer({ minimum: 1 }), rawTotalSlots: Type.Integer({ minimum: 0 }), fixedReserveSlots: Type.Integer({ minimum: 0 }), availableMatchSlots: Type.Integer({ minimum: 0 }), requiredMatchSlots: Type.Integer({ minimum: 0 }), remainingMatchSlots: Type.Integer(), status: Type.String({ minLength: 1, maxLength: 50 }) }),
    }),
  }),
  strict({ step_id: Type.Literal("settings"), value: Type.Array(SettingsReference, { maxItems: 100 }) }),
  strict({
    step_id: Type.Literal("entries"),
    value: strict({ competition_id: Id, divisions: Type.Array(strict({ division_id: Id, division_revision: Type.Integer({ minimum: 1 }), entry_ids: Type.Array(Id, { uniqueItems: true, maxItems: 10_000 }), confirmed_count: Type.Integer({ minimum: 0 }), placeholder_count: Type.Integer({ minimum: 0 }) }), { maxItems: 1_000 }), imports: Type.Array(strict({ import_id: Id, status: Type.Union([Type.Literal("validated"), Type.Literal("applied"), Type.Literal("rolled_back")]), accepted_row_count: Type.Integer({ minimum: 0 }), rejected_row_count: Type.Integer({ minimum: 0 }) }), { maxItems: 1_000 }), total_entry_count: Type.Integer({ minimum: 0 }) }),
  }),
  strict({ step_id: Type.Literal("format_preferences"), value: strict({ minimum_matches: strict({ per_entry: Type.Integer({ minimum: 1, maximum: 100 }) }), ranking: strict({ rank_all_entries: Type.Boolean() }), knockout: strict({ required: Type.Boolean() }), placement: strict({ required: Type.Boolean() }), qualification: strict({ cross_group_allowed: Type.Boolean() }), priority: strict({ value: Type.Union([Type.Literal("speed"), Type.Literal("simplicity"), Type.Literal("participation")]) }) }) }),
  strict({ step_id: Type.Literal("format_recommendations"), value: strict({ recommendations: Type.Array(Recommendation, { maxItems: 3 }), requires_changes: Type.Union([Type.Null(), Recommendation]), selected_recommendation_id: Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: 128 })]), acknowledged_capacity_shortfall: Type.Boolean(), recommendation_set_hash: Hash }) }),
  strict({ step_id: Type.Literal("schedule_review"), value: strict({ schedule_job_id: Id, source_revision: Type.Integer({ minimum: 1 }), selected_recommendation_id: Type.String({ minLength: 1, maxLength: 128 }), format_revision_id: Id, format_definition_hash: Hash, capacity_revision: Type.Integer({ minimum: 1 }), settings_references: Type.Array(SettingsPointer, { maxItems: 100 }), selected_result_revision: Type.Integer({ minimum: 1 }), selected_result_hash: Hash, objective: Objective, schedule_revision_id: Id, feasibility: Type.Union([Type.Literal("valid"), Type.Literal("infeasible")]) }) }),
  strict({ step_id: Type.Literal("review_publish"), value: ReviewSelection }),
]);
const SetupAutosaveBody = strict({
  expected_revision: Type.Integer({ minimum: 1 }),
  idempotency_key: IdempotencyKey,
  transition: Type.Union([
    strict({ kind: Type.Literal("save_step"), step: SetupStepValue }),
    strict({ kind: Type.Literal("go_to_step"), step_id: SetupStep }),
    strict({ kind: Type.Literal("complete"), review: ReviewSelection }),
  ]),
});

const MoveTarget = strict({
  match_id: Id,
  playing_area_id: Id,
  slot_id: Type.String({ minLength: 1, maxLength: 200 }),
  start_epoch_ms: Type.Integer({ minimum: 0 }),
  end_epoch_ms: Type.Integer({ minimum: 1 }),
});

export async function registerPhase4Routes(
  app: FastifyInstance,
  options: {
    runtime: Phase4Runtime;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
    deepHealthToken?: string;
  },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => ({
    accountId: (await options.identityRequests.authenticate(request)).account.id,
  });
  const mutationActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !options.allowedOrigins.includes(origin))
      throw new ApiError(403, "ORIGIN_REJECTED", "Request origin is not allowed");
    const session = await options.identityRequests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.identityRuntime.verifyCsrfToken(session.sessionToken, csrf))
      throw new ApiError(403, "CSRF_INVALID", "CSRF validation failed");
    return { accountId: session.account.id };
  };
  const read = { security: [{ sessionCookie: [] }], response: { 200: Json, ...ReadResponses } };
  const mutation = { security: [{ sessionCookie: [] }], headers: MutationHeaders };

  app.post<{ Params: { competitionId: string }; Body: { idempotency_key: string } }>(
    "/api/v1/competitions/:competitionId/setup-draft",
    {
      schema: {
        ...mutation,
        params: strict({ competitionId: Id }),
        body: strict({ idempotency_key: IdempotencyKey }),
        response: { 201: Json, ...MutationResponses },
        tags: ["phase4-setup"],
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await options.runtime.createSetupDraft(
            await mutationActor(request),
            request.params.competitionId,
            request.body.idempotency_key,
            request.id,
          ),
        ),
  );
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/setup-draft",
    { schema: { ...read, params: strict({ competitionId: Id }), tags: ["phase4-setup"] } },
    async (request) => options.runtime.readSetupDraft(await readActor(request), request.params.competitionId),
  );
  app.put<{ Params: { competitionId: string }; Body: Static<typeof SetupAutosaveBody> }>(
    "/api/v1/competitions/:competitionId/setup-draft",
    {
      schema: {
        ...mutation,
        params: strict({ competitionId: Id }),
        body: SetupAutosaveBody,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-setup"],
      },
    },
    async (request) =>
      options.runtime.autosaveSetupDraft(
        await mutationActor(request),
        request.params.competitionId,
        request.body as Parameters<Phase4Runtime["autosaveSetupDraft"]>[2],
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string; divisionId: string } }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/format-builder",
    {
      schema: {
        ...read,
        params: strict({ competitionId: Id, divisionId: Id }),
        tags: ["phase4-formats"],
      },
    },
    async (request) =>
      options.runtime.readFormatBuilder(
        await readActor(request),
        request.params.competitionId,
        request.params.divisionId,
      ),
  );
  app.post<{
    Params: { competitionId: string; divisionId: string };
    Body: { document: Static<typeof FormatDocument> };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/format-builder/validate",
    {
      schema: {
        ...mutation,
        params: strict({ competitionId: Id, divisionId: Id }),
        body: strict({ document: FormatDocument }),
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-formats"],
      },
    },
    async (request) =>
      options.runtime.validateFormat(
        await mutationActor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.body.document,
      ),
  );
  const SaveFormatBody = strict({
    idempotency_key: IdempotencyKey,
    draft_id: Type.Union([Id, Type.Null()]),
    expected_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    parent_revision_id: Type.Union([Id, Type.Null()]),
    document: FormatDocument,
  });
  app.put<{
    Params: { competitionId: string; divisionId: string };
    Body: Static<typeof SaveFormatBody>;
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/format-builder",
    {
      schema: {
        ...mutation,
        params: strict({ competitionId: Id, divisionId: Id }),
        body: SaveFormatBody,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-formats"],
      },
    },
    async (request) =>
      options.runtime.saveFormatRevision(
        await mutationActor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.body,
        request.id,
      ),
  );
  app.post<{ Params: { formatId: string }; Body: { idempotency_key: string } }>(
    "/api/v1/format-revisions/:formatId/materialise",
    {
      schema: {
        ...mutation,
        params: strict({ formatId: Id }),
        body: strict({ idempotency_key: IdempotencyKey }),
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-formats"],
      },
    },
    async (request) =>
      options.runtime.materialiseFormat(
        await mutationActor(request),
        request.params.formatId,
        request.body.idempotency_key,
        request.id,
      ),
  );
  app.post<{ Params: { formatId: string }; Body: { idempotency_key: string } }>(
    "/api/v1/format-revisions/:formatId/publish",
    {
      schema: {
        ...mutation,
        params: strict({ formatId: Id }),
        body: strict({ idempotency_key: IdempotencyKey }),
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-formats"],
      },
    },
    async (request) =>
      options.runtime.publishFormat(
        await mutationActor(request),
        request.params.formatId,
        request.body.idempotency_key,
        request.id,
      ),
  );

  app.get<{ Params: { organisationId: string }; Querystring: { include_archived?: boolean } }>(
    "/api/v1/organisations/:organisationId/format-templates",
    {
      schema: {
        ...read,
        params: strict({ organisationId: Id }),
        querystring: strict({ include_archived: Type.Optional(Type.Boolean()) }),
        tags: ["phase4-format-templates"],
      },
    },
    async (request) =>
      options.runtime.listFormatTemplates(
        await readActor(request),
        request.params.organisationId,
        request.query.include_archived ?? false,
      ),
  );
  const TemplateBody = strict({
    idempotency_key: IdempotencyKey,
    template_id: Type.Union([Id, Type.Null()]),
    parent_version_id: Type.Union([Id, Type.Null()]),
    expected_version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2_000 }), Type.Null()])),
    sport_code: Sport,
    source_format_revision_id: Id,
  });
  app.post<{ Params: { organisationId: string }; Body: Static<typeof TemplateBody> }>(
    "/api/v1/organisations/:organisationId/format-templates",
    {
      schema: {
        ...mutation,
        params: strict({ organisationId: Id }),
        body: TemplateBody,
        response: { 201: Json, ...MutationResponses },
        tags: ["phase4-format-templates"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.saveFormatTemplate(
          await mutationActor(request),
          request.params.organisationId,
          request.body as Parameters<Phase4Runtime["saveFormatTemplate"]>[2],
          request.id,
        ),
      ),
  );
  app.post<{
    Params: { organisationId: string; templateId: string };
    Body: { expected_status: "active"; idempotency_key: string };
  }>(
    "/api/v1/organisations/:organisationId/format-templates/:templateId/archive",
    {
      schema: {
        ...mutation,
        params: strict({ organisationId: Id, templateId: Id }),
        body: strict({ expected_status: Type.Literal("active"), idempotency_key: IdempotencyKey }),
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-format-templates"],
      },
    },
    async (request) =>
      options.runtime.archiveFormatTemplate(
        await mutationActor(request),
        request.params.organisationId,
        request.params.templateId,
        request.body,
        request.id,
      ),
  );
  const ApplyTemplateBody = strict({
    competition_id: Id,
    division_id: Id,
    template_version_id: Id,
    expected_format_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    idempotency_key: IdempotencyKey,
  });
  app.post<{ Params: { organisationId: string }; Body: Static<typeof ApplyTemplateBody> }>(
    "/api/v1/organisations/:organisationId/format-templates/apply",
    {
      schema: {
        ...mutation,
        params: strict({ organisationId: Id }),
        body: ApplyTemplateBody,
        response: { 201: Json, ...MutationResponses },
        tags: ["phase4-format-templates"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.applyFormatTemplate(
          await mutationActor(request),
          request.params.organisationId,
          request.body,
          request.id,
        ),
      ),
  );

  app.get<{ Params: { organisationId: string } }>(
    "/api/v1/organisations/:organisationId/ai/usage",
    { schema: { ...read, params: strict({ organisationId: Id }), tags: ["phase4-ai"] } },
    async (request) => options.runtime.readAiUsage(await readActor(request), request.params.organisationId),
  );
  const AiBriefBody = strict({
    idempotency_key: IdempotencyKey,
    text: Type.String({ minLength: 1, maxLength: 10_000 }),
    locale: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$" })),
    competition_id: Type.Optional(Type.Union([Id, Type.Null()])),
  });
  app.post<{ Params: { organisationId: string }; Body: Static<typeof AiBriefBody> }>(
    "/api/v1/organisations/:organisationId/ai/competition-brief",
    {
      schema: {
        ...mutation,
        params: strict({ organisationId: Id }),
        body: AiBriefBody,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-ai"],
      },
    },
    async (request) =>
      options.runtime.textToBrief(
        await mutationActor(request),
        request.params.organisationId,
        request.body,
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/schedule-workspace",
    { schema: { ...read, params: strict({ competitionId: Id }), tags: ["phase4-schedules"] } },
    async (request) => options.runtime.scheduleWorkspace(await readActor(request), request.params.competitionId),
  );
  const GenerateBody = strict({
    idempotency_key: IdempotencyKey,
    expected_source_revision: Type.Integer({ minimum: 1 }),
    expected_capacity_revision: Type.Integer({ minimum: 1 }),
    objective: Objective,
    constraints: Constraints,
  });
  app.post<{ Params: { competitionId: string }; Body: Static<typeof GenerateBody> }>(
    "/api/v1/competitions/:competitionId/schedule-jobs",
    {
      schema: {
        ...mutation,
        params: strict({ competitionId: Id }),
        body: GenerateBody,
        response: { 202: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request, reply) => {
      const result = await options.runtime.generateSchedule(
        await mutationActor(request),
        request.params.competitionId,
        request.body,
        request.id,
      );
      if (!result.enqueued)
        return reply.code(503).send({
          error: {
            code: "SCHEDULE_QUEUE_UNAVAILABLE",
            message: `Schedule job ${result.job.id} was persisted and will be recovered`,
            request_id: request.id,
          },
        });
      return reply.code(202).send(result);
    },
  );
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/schedule-jobs",
    { schema: { ...read, params: strict({ competitionId: Id }), tags: ["phase4-schedules"] } },
    async (request) => options.runtime.listScheduleJobs(await readActor(request), request.params.competitionId),
  );
  app.get<{ Params: { jobId: string } }>(
    "/api/v1/schedule-jobs/:jobId",
    { schema: { ...read, params: strict({ jobId: Id }), tags: ["phase4-schedules"] } },
    async (request) => options.runtime.readScheduleJob(await readActor(request), request.params.jobId),
  );
  app.get<{ Params: { jobId: string } }>(
    "/api/v1/schedule-jobs/:jobId/options",
    { schema: { ...read, params: strict({ jobId: Id }), tags: ["phase4-schedules"] } },
    async (request) => options.runtime.listScheduleOptions(await readActor(request), request.params.jobId),
  );
  const JobMutationBody = strict({ idempotency_key: IdempotencyKey, expected_revision: Type.Integer({ minimum: 1 }) });
  app.post<{ Params: { jobId: string }; Body: Static<typeof JobMutationBody> }>(
    "/api/v1/schedule-jobs/:jobId/continue",
    {
      schema: {
        ...mutation,
        params: strict({ jobId: Id }),
        body: JobMutationBody,
        response: { 202: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request, reply) => {
      const result = await options.runtime.continueScheduleJob(
        await mutationActor(request),
        request.params.jobId,
        request.body,
        request.id,
      );
      if (!result.enqueued)
        return reply.code(503).send({
          error: {
            code: "SCHEDULE_QUEUE_UNAVAILABLE",
            message: `Schedule job ${result.job.id} was persisted and will be recovered`,
            request_id: request.id,
          },
        });
      return reply.code(202).send(result);
    },
  );
  app.post<{ Params: { jobId: string }; Body: Static<typeof JobMutationBody> }>(
    "/api/v1/schedule-jobs/:jobId/cancel",
    {
      schema: {
        ...mutation,
        params: strict({ jobId: Id }),
        body: JobMutationBody,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request) =>
      options.runtime.cancelScheduleJob(
        await mutationActor(request),
        request.params.jobId,
        request.body,
        request.id,
      ),
  );
  const AcceptBody = strict({ idempotency_key: IdempotencyKey, expected_job_revision: Type.Integer({ minimum: 1 }) });
  app.post<{ Params: { jobId: string; optionId: string }; Body: Static<typeof AcceptBody> }>(
    "/api/v1/schedule-jobs/:jobId/options/:optionId/accept",
    {
      schema: {
        ...mutation,
        params: strict({ jobId: Id, optionId: Id }),
        body: AcceptBody,
        response: { 201: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.acceptScheduleOption(
          await mutationActor(request),
          request.params.jobId,
          request.params.optionId,
          request.body,
          request.id,
        ),
      ),
  );
  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/schedule-revisions",
    { schema: { ...read, params: strict({ competitionId: Id }), tags: ["phase4-schedules"] } },
    async (request) => options.runtime.listScheduleRevisions(await readActor(request), request.params.competitionId),
  );
  app.get<{ Params: { revisionId: string } }>(
    "/api/v1/schedule-revisions/:revisionId",
    { schema: { ...read, params: strict({ revisionId: Id }), tags: ["phase4-schedules"] } },
    async (request) => options.runtime.readScheduleRevision(await readActor(request), request.params.revisionId),
  );
  app.get<{ Params: { leftId: string; rightId: string } }>(
    "/api/v1/schedule-revisions/:leftId/compare/:rightId",
    { schema: { ...read, params: strict({ leftId: Id, rightId: Id }), tags: ["phase4-schedules"] } },
    async (request) =>
      options.runtime.compareScheduleRevisions(
        await readActor(request),
        request.params.leftId,
        request.params.rightId,
      ),
  );
  app.post<{ Params: { revisionId: string }; Body: Static<typeof MoveTarget> }>(
    "/api/v1/schedule-revisions/:revisionId/moves/validate",
    {
      schema: {
        ...mutation,
        params: strict({ revisionId: Id }),
        body: MoveTarget,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request) =>
      options.runtime.validateScheduleMove(await mutationActor(request), request.params.revisionId, request.body),
  );
  const MoveBody = strict({
    match_id: Id,
    playing_area_id: Id,
    slot_id: Type.String({ minLength: 1, maxLength: 200 }),
    start_epoch_ms: Type.Integer({ minimum: 0 }),
    end_epoch_ms: Type.Integer({ minimum: 1 }),
    idempotency_key: IdempotencyKey,
    expected_revision: Type.Integer({ minimum: 1 }),
  });
  app.post<{ Params: { revisionId: string }; Body: Static<typeof MoveBody> }>(
    "/api/v1/schedule-revisions/:revisionId/moves",
    {
      schema: {
        ...mutation,
        params: strict({ revisionId: Id }),
        body: MoveBody,
        response: { 201: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.moveScheduleMatch(
          await mutationActor(request),
          request.params.revisionId,
          request.body,
          request.id,
        ),
      ),
  );
  const LockBody = strict({
    idempotency_key: IdempotencyKey,
    match_id: Id,
    playing_area_id: Id,
    start_epoch_ms: Type.Integer({ minimum: 0 }),
    end_epoch_ms: Type.Integer({ minimum: 1 }),
  });
  app.post<{ Params: { revisionId: string }; Body: Static<typeof LockBody> }>(
    "/api/v1/schedule-revisions/:revisionId/locks",
    {
      schema: {
        ...mutation,
        params: strict({ revisionId: Id }),
        body: LockBody,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request) =>
      options.runtime.lockScheduleAssignment(
        await mutationActor(request),
        request.params.revisionId,
        request.body,
        request.id,
      ),
  );
  app.delete<{
    Params: { revisionId: string; matchId: string };
    Body: { idempotency_key: string };
  }>(
    "/api/v1/schedule-revisions/:revisionId/locks/:matchId",
    {
      schema: {
        ...mutation,
        params: strict({ revisionId: Id, matchId: Id }),
        body: strict({ idempotency_key: IdempotencyKey }),
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request) =>
      options.runtime.unlockScheduleAssignment(
        await mutationActor(request),
        request.params.revisionId,
        request.params.matchId,
        request.body.idempotency_key,
        request.id,
      ),
  );
  app.post<{ Params: { revisionId: string }; Body: Static<typeof JobMutationBody> }>(
    "/api/v1/schedule-revisions/:revisionId/ready",
    {
      schema: {
        ...mutation,
        params: strict({ revisionId: Id }),
        body: JobMutationBody,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request) =>
      options.runtime.markScheduleReady(
        await mutationActor(request),
        request.params.revisionId,
        request.body,
        request.id,
      ),
  );
  app.post<{ Params: { revisionId: string }; Body: Static<typeof JobMutationBody> }>(
    "/api/v1/schedule-revisions/:revisionId/publish",
    {
      schema: {
        ...mutation,
        params: strict({ revisionId: Id }),
        body: JobMutationBody,
        response: { 200: Json, ...MutationResponses },
        tags: ["phase4-schedules"],
      },
    },
    async (request) =>
      options.runtime.publishScheduleRevision(
        await mutationActor(request),
        request.params.revisionId,
        request.body,
        request.id,
      ),
  );

  app.post<{ Headers: { "x-deep-health-token"?: string } }>(
    "/internal/phase4/schedule-maintenance",
    {
      schema: {
        headers: strict({ "x-deep-health-token": Type.Optional(Type.String()) }),
        response: { 200: Json, 404: ErrorResponse },
        tags: ["internal"],
      },
      config: { rateLimit: false },
    },
    async (request) => {
      if (!options.deepHealthToken || request.headers["x-deep-health-token"] !== options.deepHealthToken)
        throw new ApiError(404, "ROUTE_NOT_FOUND", "Route not found");
      const maintenance = await options.runtime.runScheduleMaintenance(request.id);
      const queueRecovery = await options.runtime.recoverQueuedScheduleJobs();
      return { ...maintenance, queue_recovery: queueRecovery };
    },
  );
}
