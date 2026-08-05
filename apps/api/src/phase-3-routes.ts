import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { Phase3Actor, Phase3Runtime } from "./phase-3-runtime.js";

const Id = Type.String({ format: "uuid" });
const IdempotencyKey = Type.String({ pattern: "^[A-Za-z0-9._:-]{8,200}$" });
const ErrorResponse = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});
const MutationHeaders = Type.Object({
  origin: Type.Optional(Type.String()),
  "x-csrf-token": Type.Optional(Type.String()),
});
const Generic = Type.Record(Type.String(), Type.Any());
const NullableString = Type.Union([Type.Null(), Type.String()]);
const Sport = Type.Union([
  Type.Literal("canoe_polo"),
  Type.Literal("badminton"),
  Type.Literal("table_tennis"),
  Type.Literal("volleyball"),
  Type.Literal("basketball"),
]);
const OrganisationOptionsResponse = Type.Array(
  Type.Object(
    {
      id: Id,
      name: Type.String({ minLength: 1 }),
      role: Type.Union([Type.Literal("owner"), Type.Literal("organiser")]),
    },
    { additionalProperties: false },
  ),
);
const OrganiserCompetitionListResponse = Type.Array(
  Type.Object(
    {
      id: Id,
      name: Type.String({ minLength: 1 }),
      slug: Type.String({ minLength: 1 }),
      sport_code: Sport,
      status: Type.String({ minLength: 1 }),
      starts_on: Type.String({ format: "date" }),
      ends_on: Type.String({ format: "date" }),
      organisation_name: Type.String({ minLength: 1 }),
      membership_role: Type.Union([Type.Literal("owner"), Type.Literal("organiser"), Type.Literal("viewer")]),
    },
    { additionalProperties: false },
  ),
);
const JsonObject = Type.Record(Type.String(), Type.Unknown());
const SportSettingsResponse = Type.Object(
  {
    competition_id: Id,
    division_id: Type.Union([Id, Type.Null()]),
    sport_code: Sport,
    pack_version: Type.String(),
    pack_schema_version: Type.Integer({ minimum: 1 }),
    pack_definition_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    pack_definition: JsonObject,
    recommended_snapshot: JsonObject,
    competition_override: JsonObject,
    override: JsonObject,
    revision: Type.Integer({ minimum: 1 }),
    effective: JsonObject,
    mode: Type.Union([Type.Literal("recommended"), Type.Literal("customised")]),
    permission: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    read_only: Type.Boolean(),
    organisation_id: Id,
  },
  { additionalProperties: false },
);
const CapacityWindowRequest = Type.Object(
  {
    id: Type.Optional(Id),
    date: Type.String({ format: "date" }),
    start_time: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
    end_time: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
    cross_midnight: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const CapacityWindowResponse = Type.Object(
  {
    id: Id,
    date: Type.String({ format: "date" }),
    start_time: Type.String(),
    end_time: Type.String(),
    cross_midnight: Type.Boolean(),
    starts_at: Type.String({ format: "date-time" }),
    ends_at: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
const CapacityEffective = Type.Object(
  {
    timeZone: Type.String(),
    slotMinutes: Type.Integer(),
    rawTotalSlots: Type.Integer(),
    fixedReserveSlots: Type.Integer(),
    availableMatchSlots: Type.Integer(),
    requiredMatchSlots: Type.Integer(),
    remainingMatchSlots: Type.Integer(),
    status: Type.Union([Type.Literal("comfortable"), Type.Literal("tight"), Type.Literal("does_not_fit")]),
    intervals: Type.Array(
      Type.Object({
        id: Type.String(),
        areaId: Id,
        areaName: Type.String(),
        startEpochMs: Type.Number(),
        endEpochMs: Type.Number(),
        startIso: Type.String({ format: "date-time" }),
        endIso: Type.String({ format: "date-time" }),
        usableMinutes: Type.Number(),
        slots: Type.Integer(),
        unusedMinutes: Type.Number(),
        sourceAvailabilityIds: Type.Array(Id),
      }),
    ),
    areas: Type.Array(
      Type.Object({
        areaId: Id,
        areaName: Type.String(),
        sortOrder: Type.Integer(),
        usableMinutes: Type.Number(),
        rawSlots: Type.Integer(),
        intervalCount: Type.Integer(),
      }),
    ),
  },
  { additionalProperties: false },
);
const CapacityResponse = Type.Object(
  {
    competition_id: Id,
    revision: Type.Integer({ minimum: 1 }),
    timezone: Type.String(),
    permission: Type.Union([Type.Literal("read"), Type.Literal("write")]),
    read_only: Type.Boolean(),
    areas: Type.Array(
      Type.Object(
        {
          id: Id,
          name: Type.String(),
          sort_order: Type.Integer(),
          slot_minutes: Type.Integer(),
          fixed_reserve_slots: Type.Integer(),
          availability: Type.Array(CapacityWindowResponse),
          unavailable: Type.Array(CapacityWindowResponse),
        },
        { additionalProperties: false },
      ),
    ),
    effective: CapacityEffective,
    idempotent_replay: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const StandingsResponse = Type.Object(
  {
    id: Id,
    competition_id: Id,
    division_id: Id,
    result_version: Type.Integer({ minimum: 0 }),
    standings: Type.Unknown(),
    explanation: Type.Unknown(),
    calculation_input_hash: Type.String(),
    source_result_hash: Type.String(),
    settings_version: Type.String(),
    snapshot_fingerprint: Type.String(),
    created_at: Type.String({ format: "date-time" }),
    advancement_slots: Type.Array(
      Type.Object(
        {
          match_id: Id,
          slot: Type.Union([Type.Literal("home"), Type.Literal("away")]),
          entry_id: NullableString,
          control: Type.Union([Type.Literal("manual"), Type.Literal("automatic")]),
          controlled_by_rule_id: NullableString,
          source_snapshot_id: NullableString,
          source_fingerprint: NullableString,
          result_version: Type.Integer({ minimum: 0 }),
          updated_at: Type.String({ format: "date-time" }),
        },
        { additionalProperties: false },
      ),
    ),
    advancement_conflicts: Type.Array(
      Type.Object(
        {
          id: Id,
          rule_id: Type.String(),
          target_slot_id: Type.String(),
          reason: Type.String(),
          status: Type.Literal("open"),
          result_version: Type.Integer({ minimum: 1 }),
          created_at: Type.String({ format: "date-time" }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const SportPackDraftResponse = Type.Object(
  {
    sport_code: Sport,
    version: Type.String(),
    schema_version: Type.Integer(),
    definition_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    status: Type.Literal("draft"),
    revision: Type.Integer({ minimum: 1 }),
    created_by: Id,
    created_at: Type.String({ format: "date-time" }),
    idempotent_replay: Type.Boolean(),
  },
  { additionalProperties: false },
);
const SportPackActivationResponse = Type.Object(
  {
    sport_code: Sport,
    version: Type.String(),
    schema_version: Type.Integer(),
    definition_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    status: Type.Literal("active"),
    revision: Type.Integer({ minimum: 2 }),
    activated_by: Id,
    activated_at: Type.String({ format: "date-time" }),
    previous_active_version: NullableString,
    idempotent_replay: Type.Boolean(),
  },
  { additionalProperties: false },
);
const SportPackAdminReadResponse = Type.Object(
  {
    sport_code: Sport,
    version: Type.String(),
    schema_version: Type.Integer(),
    definition: Type.Unknown(),
    definition_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    status: Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("superseded")]),
    revision: Type.Integer({ minimum: 1 }),
    created_by: NullableString,
    created_at: Type.String({ format: "date-time" }),
    activated_by: NullableString,
    activated_at: NullableString,
    superseded_at: NullableString,
    superseded_by: NullableString,
    superseded_by_version: NullableString,
    read_only: Type.Literal(true),
  },
  { additionalProperties: false },
);
const SportPackAdminListResponse = Type.Object(
  {
    sport_code: Sport,
    active_version: NullableString,
    versions: Type.Array(
      Type.Object(
        {
          version: Type.String(),
          schema_version: Type.Integer({ minimum: 1 }),
          definition_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          status: Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("superseded")]),
          revision: Type.Integer({ minimum: 1 }),
          created_at: Type.String({ format: "date-time" }),
          activated_at: NullableString,
          superseded_at: NullableString,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const EntryAvailability = Type.Array(
  Type.Object(
    {
      start: Type.String({ format: "date-time" }),
      end: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
  ),
  { maxItems: 512 },
);
const FormatStageKind = Type.Union([
  Type.Literal("round_robin"),
  Type.Literal("group"),
  Type.Literal("single_elimination"),
  Type.Literal("placement"),
  Type.Literal("consolation"),
  Type.Literal("classification"),
  Type.Literal("bronze"),
]);
const FormatParticipantSource = Type.Union([
  Type.Object(
    { type: Type.Literal("entry_seed"), seed: Type.Integer({ minimum: 1, maximum: 48 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("stage_rank"),
      stageId: Type.String({ minLength: 1, maxLength: 128 }),
      groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      rank: Type.Integer({ minimum: 1, maximum: 48 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("winner"), matchId: Type.String({ minLength: 1, maxLength: 128 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("loser"), matchId: Type.String({ minLength: 1, maxLength: 128 }) },
    { additionalProperties: false },
  ),
]);
const FormatGraphRequest = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    schemaVersion: Type.Literal(1),
    entryCount: Type.Integer({ minimum: 2, maximum: 48 }),
    stages: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          label: Type.String({ minLength: 1, maxLength: 160 }),
          kind: FormatStageKind,
          order: Type.Integer({ minimum: 1 }),
          groupIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            maxItems: 48,
            uniqueItems: true,
          }),
          groupSize: Type.Union([Type.Integer({ minimum: 2, maximum: 48 }), Type.Null()]),
          outputRanks: Type.Integer({ minimum: 1, maximum: 48 }),
          matchIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            minItems: 1,
            maxItems: 1_128,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 64 },
    ),
    matches: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 128 }),
          stageId: Type.String({ minLength: 1, maxLength: 128 }),
          poolId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          round: Type.Integer({ minimum: 1 }),
          order: Type.Integer({ minimum: 1 }),
          purpose: Type.Union([
            Type.Literal("pool"),
            Type.Literal("progression"),
            Type.Literal("championship"),
            Type.Literal("placement"),
            Type.Literal("classification"),
          ]),
          home: FormatParticipantSource,
          away: FormatParticipantSource,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 1_128 },
    ),
    terminalMatchIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: 1_128,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
type FormatGraphRequest = Static<typeof FormatGraphRequest>;

export async function registerPhase3Routes(
  app: FastifyInstance,
  options: {
    runtime: Phase3Runtime;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
    registerCanonicalMutations?: boolean;
  },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => ({
    accountId: (await options.identityRequests.authenticate(request)).account.id,
  });
  const actor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !options.allowedOrigins.includes(origin)) {
      throw new ApiError(403, "ORIGIN_REJECTED", "Request origin is not allowed");
    }
    const session = await options.identityRequests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.identityRuntime.verifyCsrfToken(session.sessionToken, csrf)) {
      throw new ApiError(403, "CSRF_INVALID", "CSRF validation failed");
    }
    return { accountId: session.account.id };
  };

  app.get(
    "/api/v1/organisations/competition-options",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        response: { 200: OrganisationOptionsResponse, 401: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request) => options.runtime.listWritableOrganisations(await readActor(request)),
  );

  app.get(
    "/api/v1/competitions",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        response: { 200: OrganiserCompetitionListResponse, 401: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request) => options.runtime.listOrganiserCompetitions(await readActor(request)),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/phase3",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request) => options.runtime.readCompetition(await readActor(request), request.params.competitionId),
  );

  app.post<{
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: {
      organisation_id: string;
      name: string;
      slug: string;
      sport_code: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
      venue: string;
      address: string;
      locality?: string;
      country_code: string;
      starts_on: string;
      ends_on: string;
      timezone: string;
      locale: string;
      idempotency_key: string;
    };
  }>(
    "/api/v1/competitions/phase3",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        body: Type.Object(
          {
            organisation_id: Id,
            name: Type.String({ minLength: 1, maxLength: 160 }),
            slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
            sport_code: Sport,
            venue: Type.String({ minLength: 1 }),
            address: Type.String({ minLength: 1 }),
            locality: Type.Optional(Type.String()),
            country_code: Type.String({ pattern: "^[A-Z]{2}$" }),
            starts_on: Type.String({ format: "date" }),
            ends_on: Type.String({ format: "date" }),
            timezone: Type.String(),
            locale: Type.String(),
            idempotency_key: Type.String({ pattern: "^[A-Za-z0-9._:-]{8,200}$" }),
          },
          { additionalProperties: false },
        ),
        response: { 201: Generic, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.createCompetition(
          await actor(request),
          {
            organisationId: request.body.organisation_id,
            name: request.body.name,
            slug: request.body.slug,
            sportCode: request.body.sport_code,
            venue: request.body.venue,
            address: request.body.address,
            ...(request.body.locality ? { locality: request.body.locality } : {}),
            countryCode: request.body.country_code,
            startsOn: request.body.starts_on,
            endsOn: request.body.ends_on,
            timezone: request.body.timezone,
            locale: request.body.locale,
          },
          request.id,
          request.body.idempotency_key,
        ),
      ),
  );

  app.patch<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: {
      revision: number;
      idempotency_key: string;
      name?: string;
      slug?: string;
      sport_code?: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball";
      venue?: string;
      address?: string;
      locality?: string | null;
      country_code?: string;
      starts_on?: string;
      ends_on?: string;
      timezone?: string;
      locale?: string;
    };
  }>(
    "/api/v1/competitions/:competitionId/phase3",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
            slug: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })),
            sport_code: Type.Optional(Sport),
            venue: Type.Optional(Type.String({ minLength: 1 })),
            address: Type.Optional(Type.String({ minLength: 1 })),
            locality: Type.Optional(Type.Union([Type.Null(), Type.String()])),
            country_code: Type.Optional(Type.String({ pattern: "^[A-Z]{2}$" })),
            starts_on: Type.Optional(Type.String({ format: "date" })),
            ends_on: Type.Optional(Type.String({ format: "date" })),
            timezone: Type.Optional(Type.String({ minLength: 1 })),
            locale: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request) =>
      options.runtime.mutateCompetition(
        await actor(request),
        request.params.competitionId,
        {
          revision: request.body.revision,
          action: "update",
          patch: {
            ...(request.body.name === undefined ? {} : { name: request.body.name }),
            ...(request.body.slug === undefined ? {} : { slug: request.body.slug }),
            ...(request.body.sport_code === undefined ? {} : { sportCode: request.body.sport_code }),
            ...(request.body.venue === undefined ? {} : { venue: request.body.venue }),
            ...(request.body.address === undefined ? {} : { address: request.body.address }),
            ...(request.body.locality === undefined ? {} : { locality: request.body.locality }),
            ...(request.body.country_code === undefined ? {} : { countryCode: request.body.country_code }),
            ...(request.body.starts_on === undefined ? {} : { startsOn: request.body.starts_on }),
            ...(request.body.ends_on === undefined ? {} : { endsOn: request.body.ends_on }),
            ...(request.body.timezone === undefined ? {} : { timezone: request.body.timezone }),
            ...(request.body.locale === undefined ? {} : { locale: request.body.locale }),
          },
        },
        request.id,
      ),
  );

  app.delete<{ Params: { competitionId: string }; Headers: { origin?: string; "x-csrf-token"?: string } }>(
    "/api/v1/competitions/:competitionId/phase3",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request) =>
      options.runtime.deleteCompetition(await actor(request), request.params.competitionId, request.id),
  );

  app.post<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { revision: number; action: "archive" | "restore" };
  }>(
    "/api/v1/competitions/:competitionId/lifecycle/archive",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            action: Type.Union([Type.Literal("archive"), Type.Literal("restore")]),
          },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request) =>
      options.runtime.mutateCompetition(
        await actor(request),
        request.params.competitionId,
        { revision: request.body.revision, action: request.body.action },
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { revision: number; status: "draft" | "ready" | "published" | "live" | "completed" };
  }>(
    "/api/v1/competitions/:competitionId/lifecycle/transition",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            status: Type.Union([
              Type.Literal("draft"),
              Type.Literal("ready"),
              Type.Literal("published"),
              Type.Literal("live"),
              Type.Literal("completed"),
            ]),
          },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request) =>
      options.runtime.transitionCompetition(
        await actor(request),
        request.params.competitionId,
        request.body,
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { name: string; slug: string; starts_on?: string; ends_on?: string };
  }>(
    "/api/v1/competitions/:competitionId/duplicate",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
            starts_on: Type.Optional(Type.String({ format: "date" })),
            ends_on: Type.Optional(Type.String({ format: "date" })),
          },
          { additionalProperties: false },
        ),
        response: { 201: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-competitions"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.duplicateCompetition(
          await actor(request),
          request.params.competitionId,
          {
            name: request.body.name,
            slug: request.body.slug,
            ...(request.body.starts_on ? { startsOn: request.body.starts_on } : {}),
            ...(request.body.ends_on ? { endsOn: request.body.ends_on } : {}),
          },
          request.id,
        ),
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/divisions",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: Type.Array(Generic), 401: ErrorResponse, 403: ErrorResponse },
        tags: ["phase3-divisions"],
      },
    },
    async (request) => options.runtime.listDivisions(await readActor(request), request.params.competitionId),
  );
  if (options.registerCanonicalMutations)
    app.post<{
      Params: { competitionId: string };
      Headers: { origin?: string; "x-csrf-token"?: string };
      Body: { name: string; code?: string; entry_limit: 8 | 12 | 16 | 24 | 48; idempotency_key: string };
    }>(
      "/api/v1/competitions/:competitionId/divisions",
      {
        schema: {
          security: [{ sessionCookie: [] }],
          headers: MutationHeaders,
          params: Type.Object({ competitionId: Id }),
          body: Type.Object(
            {
              name: Type.String({ minLength: 1 }),
              code: Type.Optional(Type.String()),
              entry_limit: Type.Union([8, 12, 16, 24, 48].map((value) => Type.Literal(value))),
              idempotency_key: Type.String({ pattern: "^[A-Za-z0-9._:-]{8,200}$" }),
            },
            { additionalProperties: false },
          ),
          response: { 201: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
          tags: ["phase3-divisions"],
        },
      },
      async (request, reply) =>
        reply.code(201).send(
          await options.runtime.createDivision(
            await actor(request),
            request.params.competitionId,
            {
              name: request.body.name,
              ...(request.body.code ? { code: request.body.code } : {}),
              entryLimit: request.body.entry_limit,
            },
            request.id,
            request.body.idempotency_key,
          ),
        ),
    );
  app.patch<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { revision: number; name?: string; code?: string | null; entry_limit?: 8 | 12 | 16 | 24 | 48 };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            name: Type.Optional(Type.String({ minLength: 1 })),
            code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            entry_limit: Type.Optional(Type.Union([8, 12, 16, 24, 48].map((value) => Type.Literal(value)))),
          },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-divisions"],
      },
    },
    async (request) =>
      options.runtime.updateDivision(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        {
          revision: request.body.revision,
          ...(request.body.name ? { name: request.body.name } : {}),
          ...(request.body.code !== undefined ? { code: request.body.code } : {}),
          ...(request.body.entry_limit ? { entryLimit: request.body.entry_limit } : {}),
        },
        request.id,
      ),
  );
  app.delete<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-divisions"],
      },
    },
    async (request) =>
      options.runtime.deleteDivision(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string; divisionId: string } }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        response: { 200: Type.Array(Generic), 401: ErrorResponse, 403: ErrorResponse },
        tags: ["phase3-entries"],
      },
    },
    async (request) =>
      options.runtime.listEntries(await readActor(request), request.params.competitionId, request.params.divisionId),
  );
  app.post<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: {
      name: string;
      entry_type?: string;
      seed?: number | null;
      metadata?: Record<string, unknown>;
      availability?: Array<{ start: string; end: string }>;
      idempotency_key: string;
    };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        body: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            entry_type: Type.Optional(
              Type.Union([Type.Literal("team"), Type.Literal("individual"), Type.Literal("placeholder")]),
            ),
            seed: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 48 }), Type.Null()])),
            metadata: Type.Optional(Generic),
            availability: Type.Optional(EntryAvailability),
            idempotency_key: IdempotencyKey,
          },
          { additionalProperties: false },
        ),
        response: { 201: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-entries"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.mutateEntry(
          await actor(request),
          request.params.competitionId,
          request.params.divisionId,
          {
            action: "create",
            name: request.body.name,
            ...(request.body.entry_type ? { entryType: request.body.entry_type } : {}),
            ...(request.body.seed === undefined ? {} : { seed: request.body.seed }),
            ...(request.body.metadata === undefined ? {} : { metadata: request.body.metadata }),
            ...(request.body.availability === undefined ? {} : { availability: request.body.availability }),
          },
          request.id,
          request.body.idempotency_key,
        ),
      ),
  );
  app.patch<{
    Params: { competitionId: string; divisionId: string; entryId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: {
      revision: number;
      name?: string;
      seed?: number | null;
      metadata?: Record<string, unknown>;
      availability?: Array<{ start: string; end: string }>;
      idempotency_key: string;
    };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries/:entryId",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id, entryId: Id }),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            name: Type.Optional(Type.String({ minLength: 1 })),
            seed: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 48 }), Type.Null()])),
            metadata: Type.Optional(Generic),
            availability: Type.Optional(EntryAvailability),
            idempotency_key: IdempotencyKey,
          },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-entries"],
      },
    },
    async (request) =>
      options.runtime.updateEntry(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.params.entryId,
        request.body,
        request.id,
        request.body.idempotency_key,
      ),
  );
  app.delete<{
    Params: { competitionId: string; divisionId: string; entryId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { revision: number; idempotency_key: string };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries/:entryId",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id, entryId: Id }),
        body: Type.Object(
          { revision: Type.Integer({ minimum: 1 }), idempotency_key: IdempotencyKey },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-entries"],
      },
    },
    async (request) =>
      options.runtime.deleteEntry(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.params.entryId,
        request.body.revision,
        request.id,
        request.body.idempotency_key,
      ),
  );
  app.post<{
    Params: { competitionId: string; divisionId: string; entryId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body:
      | { action: "withdraw"; reason: string }
      | {
          action: "replace";
          replacement_name: string;
          replacement_availability?: Array<{ start: string; end: string }>;
        };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries/:entryId/lifecycle",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id, entryId: Id }),
        body: Type.Union([
          Type.Object(
            { action: Type.Literal("withdraw"), reason: Type.String({ minLength: 1, maxLength: 500 }) },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              action: Type.Literal("replace"),
              replacement_name: Type.String({ minLength: 1 }),
              replacement_availability: Type.Optional(EntryAvailability),
            },
            { additionalProperties: false },
          ),
        ]),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-entries"],
      },
    },
    async (request) =>
      options.runtime.mutateEntry(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        {
          action: request.body.action,
          entryId: request.params.entryId,
          ...(request.body.action === "withdraw"
            ? { reason: request.body.reason }
            : {
                replacementName: request.body.replacement_name,
                ...(request.body.replacement_availability === undefined
                  ? {}
                  : { replacementAvailability: request.body.replacement_availability }),
              }),
        },
        request.id,
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { source_kind: "paste" | "csv"; mapping?: Record<string, string>; rows: Array<Record<string, unknown>> };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries/import",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        body: Type.Object(
          {
            source_kind: Type.Union([Type.Literal("paste"), Type.Literal("csv")]),
            mapping: Type.Optional(Type.Record(Type.String(), Type.String())),
            rows: Type.Array(Type.Record(Type.String(), Type.Any()), { minItems: 1, maxItems: 48 }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Generic,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["phase3-entries"],
      },
    },
    async (request, reply) => {
      const result = await options.runtime.importEntries(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        {
          sourceKind: request.body.source_kind,
          ...(request.body.mapping ? { mapping: request.body.mapping } : {}),
          rows: request.body.rows,
        },
        request.id,
      );
      return reply.code(result.ok ? 200 : 422).send(result);
    },
  );

  app.post<{
    Params: { competitionId: string; divisionId: string; importId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries/imports/:importId/rollback",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id, importId: Id }),
        response: {
          200: Generic,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
        tags: ["phase3-entries"],
      },
    },
    async (request) =>
      options.runtime.rollbackEntryImport(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.params.importId,
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/settings",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: SportSettingsResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) => options.runtime.readSettings(await readActor(request), request.params.competitionId),
  );
  if (options.registerCanonicalMutations) {
    app.put<{
      Params: { competitionId: string };
      Headers: { origin?: string; "x-csrf-token"?: string };
      Body: {
        revision: number;
        timezone?: string;
        areas: Array<{
          id?: string;
          name: string;
          sort_order?: number;
          slot_minutes: number;
          fixed_reserve_slots?: number;
          availability: Array<{
            id?: string;
            date: string;
            start_time: string;
            end_time: string;
            cross_midnight?: boolean;
          }>;
          unavailable?: Array<{
            id?: string;
            date: string;
            start_time: string;
            end_time: string;
            cross_midnight?: boolean;
          }>;
        }>;
      };
    }>(
      "/api/v1/competitions/:competitionId/capacity",
      {
        schema: {
          security: [{ sessionCookie: [] }],
          headers: MutationHeaders,
          params: Type.Object({ competitionId: Id }),
          body: Type.Object(
            {
              revision: Type.Integer({ minimum: 1 }),
              timezone: Type.Optional(Type.String({ minLength: 1 })),
              areas: Type.Array(
                Type.Object(
                  {
                    id: Type.Optional(Id),
                    name: Type.String({ minLength: 1 }),
                    sort_order: Type.Optional(Type.Integer({ minimum: 0 })),
                    slot_minutes: Type.Integer({ minimum: 1, maximum: 1440 }),
                    fixed_reserve_slots: Type.Optional(Type.Integer({ minimum: 0 })),
                    availability: Type.Array(CapacityWindowRequest),
                    unavailable: Type.Optional(Type.Array(CapacityWindowRequest)),
                  },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
          response: {
            200: CapacityResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            409: ErrorResponse,
            422: ErrorResponse,
          },
          tags: ["phase3-capacity"],
        },
      },
      async (request) =>
        options.runtime.replaceCapacity(
          await actor(request),
          request.params.competitionId,
          {
            revision: request.body.revision,
            ...(request.body.timezone !== undefined ? { timezone: request.body.timezone } : {}),
            areas: request.body.areas.map((area) => ({
              ...(area.id !== undefined ? { id: area.id } : {}),
              name: area.name,
              ...(area.sort_order !== undefined ? { sortOrder: area.sort_order } : {}),
              slotMinutes: area.slot_minutes,
              ...(area.fixed_reserve_slots !== undefined ? { fixedReserveSlots: area.fixed_reserve_slots } : {}),
              availability: area.availability.map((window) => ({
                ...(window.id !== undefined ? { id: window.id } : {}),
                date: window.date,
                startTime: window.start_time,
                endTime: window.end_time,
                ...(window.cross_midnight !== undefined ? { crossMidnight: window.cross_midnight } : {}),
              })),
              ...(area.unavailable
                ? {
                    unavailable: area.unavailable.map((window) => ({
                      ...(window.id !== undefined ? { id: window.id } : {}),
                      date: window.date,
                      startTime: window.start_time,
                      endTime: window.end_time,
                      ...(window.cross_midnight !== undefined ? { crossMidnight: window.cross_midnight } : {}),
                    })),
                  }
                : {}),
            })),
          },
          request.id,
        ),
    );
  }

  app.put<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { pack_version: string; revision: number; override: Record<string, unknown> };
  }>(
    "/api/v1/competitions/:competitionId/settings",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object(
          {
            pack_version: Type.String(),
            revision: Type.Integer({ minimum: 1 }),
            override: Type.Record(Type.String(), Type.Any()),
          },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) =>
      options.runtime.updateSettings(
        await actor(request),
        request.params.competitionId,
        { packVersion: request.body.pack_version, revision: request.body.revision, override: request.body.override },
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string; divisionId: string } }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/settings",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        response: { 200: SportSettingsResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) =>
      options.runtime.readSettings(await readActor(request), request.params.competitionId, request.params.divisionId),
  );
  app.put<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { pack_version: string; revision: number; override: Record<string, unknown> };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/settings",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        body: Type.Object(
          { pack_version: Type.String(), revision: Type.Integer({ minimum: 1 }), override: Generic },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) =>
      options.runtime.updateSettings(
        await actor(request),
        request.params.competitionId,
        {
          packVersion: request.body.pack_version,
          revision: request.body.revision,
          override: request.body.override,
          divisionId: request.params.divisionId,
        },
        request.id,
      ),
  );
  app.post<{ Params: { competitionId: string }; Headers: { origin?: string; "x-csrf-token"?: string } }>(
    "/api/v1/competitions/:competitionId/settings/copy-previous",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) =>
      options.runtime.copyPreviousSettings(await actor(request), request.params.competitionId, request.id),
  );

  app.get<{ Params: { sportCode: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball" } }>(
    "/api/v1/account/sport-defaults/:sportCode",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ sportCode: Sport }),
        response: { 200: Generic, 401: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) => options.runtime.readAccountDefault(await readActor(request), request.params.sportCode),
  );
  app.put<{
    Params: { sportCode: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball" };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { pack_version: string; settings: Record<string, unknown> };
  }>(
    "/api/v1/account/sport-defaults/:sportCode",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ sportCode: Sport }),
        body: Type.Object({ pack_version: Type.String(), settings: Generic }, { additionalProperties: false }),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) =>
      options.runtime.saveAccountDefault(
        await actor(request),
        request.params.sportCode,
        { packVersion: request.body.pack_version, settings: request.body.settings },
        request.id,
      ),
  );
  app.delete<{
    Params: { sportCode: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball" };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/account/sport-defaults/:sportCode",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ sportCode: Sport }),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["phase3-settings"],
      },
    },
    async (request) => options.runtime.deleteAccountDefault(await actor(request), request.params.sportCode, request.id),
  );

  app.get<{
    Params: { sportCode: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball" };
  }>(
    "/api/v1/admin/sport-packs/:sportCode",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ sportCode: Sport }),
        response: { 200: SportPackAdminListResponse, 401: ErrorResponse, 403: ErrorResponse },
        tags: ["phase3-sport-pack-admin"],
      },
    },
    async (request) => options.runtime.listSportPackAdmin(await readActor(request), request.params.sportCode),
  );

  app.get<{
    Params: { sportCode: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball"; version: string };
  }>(
    "/api/v1/admin/sport-packs/:sportCode/:version",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ sportCode: Sport, version: Type.String({ minLength: 1 }) }),
        response: { 200: SportPackAdminReadResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["phase3-sport-pack-admin"],
      },
    },
    async (request) =>
      options.runtime.readSportPackAdmin(await readActor(request), request.params.sportCode, request.params.version),
  );

  app.post<{
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { definition: unknown };
  }>(
    "/api/v1/admin/sport-packs/drafts",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        body: Type.Object({ definition: Type.Unknown() }, { additionalProperties: false }),
        response: {
          201: SportPackDraftResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["phase3-sport-pack-admin"],
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await options.runtime.createSportPackDraft(await actor(request), request.body.definition, request.id)),
  );

  app.post<{
    Params: { sportCode: "canoe_polo" | "badminton" | "table_tennis" | "volleyball" | "basketball"; version: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { revision: number; expected_active_version: string | null };
  }>(
    "/api/v1/admin/sport-packs/:sportCode/:version/activate",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ sportCode: Sport, version: Type.String({ minLength: 1 }) }),
        body: Type.Object(
          { revision: Type.Integer({ minimum: 1 }), expected_active_version: NullableString },
          { additionalProperties: false },
        ),
        response: {
          200: SportPackActivationResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
        },
        tags: ["phase3-sport-pack-admin"],
      },
    },
    async (request) =>
      options.runtime.activateSportPack(
        await actor(request),
        request.params.sportCode,
        request.params.version,
        request.body.revision,
        request.body.expected_active_version,
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/capacity",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: CapacityResponse, 401: ErrorResponse, 403: ErrorResponse },
        tags: ["phase3-capacity"],
      },
    },
    async (request) => options.runtime.capacity(await readActor(request), request.params.competitionId),
  );

  app.post<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { definition: FormatGraphRequest };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/format-revisions",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        body: Type.Object({ definition: FormatGraphRequest }, { additionalProperties: false }),
        response: { 201: Generic, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-formats"],
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await options.runtime.createFormatRevision(
            await actor(request),
            request.params.competitionId,
            request.params.divisionId,
            request.body.definition,
            request.id,
          ),
        ),
  );

  app.post<{
    Params: { competitionId: string; formatId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { definition_hash: string };
  }>(
    "/api/v1/competitions/:competitionId/format-revisions/:formatId/publish",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, formatId: Id }),
        body: Type.Object(
          { definition_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
          { additionalProperties: false },
        ),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["phase3-formats"],
      },
    },
    async (request) =>
      options.runtime.publishFormat(
        await actor(request),
        request.params.competitionId,
        request.params.formatId,
        request.body.definition_hash,
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/standings/recalculate",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        response: { 200: Generic, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["phase3-standings"],
      },
    },
    async (request) =>
      options.runtime.recalculateStandings(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string; divisionId: string } }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/standings",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        response: { 200: StandingsResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["phase3-standings"],
      },
    },
    async (request) =>
      options.runtime.readStandings(await actor(request), request.params.competitionId, request.params.divisionId),
  );
}
