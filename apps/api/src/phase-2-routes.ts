import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import {
  ScoringAccessRateLimitError,
  ScoringAccessRejectedError,
  type Phase2Actor,
  type Phase2Runtime,
} from "./phase-2-runtime.js";
import type { Phase3Runtime } from "./phase-3-runtime.js";

const Id = Type.String({ format: "uuid" });
const ErrorResponse = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }),
});
const MutationHeaders = Type.Object({
  origin: Type.Optional(Type.String()),
  "x-csrf-token": Type.Optional(Type.String()),
});
const ScoringHeaders = Type.Object({
  "x-scoring-session-id": Id,
  "x-scoring-session-token": Type.String({ minLength: 32, maxLength: 256 }),
  "x-writer-generation": Type.Optional(Type.String({ pattern: "^[1-9][0-9]*$" })),
});
const GenericSuccess = Type.Record(Type.String(), Type.Any());
const ResultMutationReceiptSchema = Type.Object(
  {
    match_id: Id,
    aggregate_version: Type.Integer({ minimum: 1 }),
    through_sequence: Type.Integer({ minimum: 1 }),
    duplicate: Type.Boolean(),
    result_version: Type.Integer({ minimum: 1 }),
    publication_version: Type.Integer({ minimum: 1 }),
    conflicts: Type.Array(Type.Record(Type.String(), Type.Any())),
  },
  { additionalProperties: false },
);
const ScoringFinalisationReceiptSchema = Type.Object(
  {
    match_id: Id,
    sequence: Type.Integer({ minimum: 1 }),
    aggregate_version: Type.Integer({ minimum: 1 }),
    duplicate: Type.Boolean(),
    home_score: Type.Integer({ minimum: 0 }),
    away_score: Type.Integer({ minimum: 0 }),
    result_version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
const PublicParticipantSchema = Type.Object({
  id: Type.Union([Id, Type.Null()]),
  name: Type.String(),
});
const PublicScheduleSchema = Type.Object({
  id: Id,
  code: Type.String(),
  stage: Type.String(),
  home: PublicParticipantSchema,
  away: PublicParticipantSchema,
  starts_at: Type.String({ format: "date-time" }),
  ends_at: Type.String({ format: "date-time" }),
  area: Type.Object({ id: Id, name: Type.String() }),
});
const PublicResultSchema = Type.Object({
  id: Id,
  code: Type.String(),
  stage: Type.String(),
  home: PublicParticipantSchema,
  away: PublicParticipantSchema,
  home_score: Type.Integer({ minimum: 0 }),
  away_score: Type.Integer({ minimum: 0 }),
  state: Type.Union([Type.Literal("final"), Type.Literal("corrected")]),
  updated_at: Type.String({ format: "date-time" }),
});
const PublicDivisionSchema = Type.Object({
  division: Type.Object({ id: Id, name: Type.String() }),
  schedule: Type.Array(PublicScheduleSchema),
  results: Type.Array(PublicResultSchema),
  standings: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
  bracket: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
});
const PublicCompetitionSchema = Type.Object({
  competition: Type.Object({
    id: Id,
    name: Type.String(),
    slug: Type.String(),
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
  divisions: Type.Array(PublicDivisionSchema, { minItems: 1 }),
  division: Type.Object({ id: Id, name: Type.String() }),
  publication: Type.Object({
    schedule_version: Type.Integer({ minimum: 0 }),
    result_version: Type.Integer({ minimum: 0 }),
  }),
  schedule: Type.Array(PublicScheduleSchema),
  results: Type.Array(PublicResultSchema),
  standings: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
  bracket: Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()]),
  last_updated_at: Type.String({ format: "date-time" }),
});
const ScoringSessionStateSchema = Type.Object({
  competition: Type.Object({
    slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    sport_code: Type.Union([
      Type.Literal("canoe_polo"),
      Type.Literal("badminton"),
      Type.Literal("table_tennis"),
      Type.Literal("volleyball"),
      Type.Literal("basketball"),
    ]),
  }),
  sport: Type.Object({
    pack_version: Type.String({ minLength: 1 }),
    settings: Type.Record(Type.String(), Type.Any()),
  }),
  match: Type.Object({
    id: Id,
    code: Type.String(),
    stage: Type.String(),
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("ready"),
      Type.Literal("in_progress"),
      Type.Literal("final"),
      Type.Literal("corrected"),
    ]),
    home: Type.Object({ id: Type.Union([Id, Type.Null()]), name: Type.Union([Type.String(), Type.Null()]) }),
    away: Type.Object({ id: Type.Union([Id, Type.Null()]), name: Type.Union([Type.String(), Type.Null()]) }),
  }),
  writer: Type.Object({
    generation: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    expires_at: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    read_only: Type.Boolean(),
  }),
  access: Type.Object({
    mode: Type.Union([
      Type.Literal("writer"),
      Type.Literal("candidate"),
      Type.Literal("viewer"),
      Type.Literal("transferred"),
    ]),
    permissions: Type.Array(
      Type.Union([
        Type.Literal("score:read"),
        Type.Literal("score:write"),
        Type.Literal("score:reverse"),
        Type.Literal("score:finalise"),
      ]),
    ),
    session_expires_at: Type.String({ format: "date-time" }),
  }),
  score: GenericSuccess,
  aggregate_version: Type.Integer({ minimum: 0 }),
  through_sequence: Type.Integer({ minimum: 0 }),
  events: Type.Array(
    Type.Object({
      client_event_id: Id,
      sequence: Type.Integer({ minimum: 1 }),
      event_id: Type.Optional(Id),
      type: Type.String({ minLength: 1, maxLength: 80 }),
      team_slot: Type.Union([Type.Literal("home"), Type.Literal("away"), Type.Null()]),
      scorer: Type.Union([Type.String(), Type.Null()]),
      manual_period: Type.Union([Type.Integer(), Type.Null()]),
      manual_event_seconds: Type.Union([Type.Integer(), Type.Null()]),
      payload: Type.Record(Type.String(), Type.Any()),
      correction_reason: Type.Union([Type.String(), Type.Null()]),
      occurred_at: Type.String({ format: "date-time" }),
    }),
  ),
});

type ScoringHeaderValues = {
  "x-scoring-session-id": string;
  "x-scoring-session-token": string;
  "x-writer-generation"?: string;
};

function requireOrigin(request: FastifyRequest, allowedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins.includes(origin)) {
    throw new ApiError(403, "ORIGIN_REJECTED", "Request origin is not allowed");
  }
}

function scoringAuth(headers: ScoringHeaderValues) {
  return {
    sessionId: headers["x-scoring-session-id"],
    sessionToken: headers["x-scoring-session-token"],
    generation: headers["x-writer-generation"] ? Number(headers["x-writer-generation"]) : null,
  };
}

function setAccessRateLimitHeaders(
  reply: { header(name: string, value: string | number): unknown },
  input: { limit: number; remaining: number; resetSeconds: number; retryAfterSeconds?: number },
) {
  reply.header("RateLimit-Limit", input.limit);
  reply.header("RateLimit-Remaining", input.remaining);
  reply.header("RateLimit-Reset", input.resetSeconds);
  if (input.retryAfterSeconds) reply.header("Retry-After", input.retryAfterSeconds);
}

export async function registerPhase2Routes(
  app: FastifyInstance,
  options: {
    runtime: Phase2Runtime;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
    phase3Runtime?: Phase3Runtime;
  },
): Promise<void> {
  const actor = async (request: FastifyRequest): Promise<Phase2Actor> => {
    requireOrigin(request, options.allowedOrigins);
    const session = await options.identityRequests.authenticate(request);
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !options.identityRuntime.verifyCsrfToken(session.sessionToken, csrf)) {
      throw new ApiError(403, "CSRF_INVALID", "CSRF validation failed");
    }
    return { accountId: session.account.id };
  };
  const readActor = async (request: FastifyRequest): Promise<Phase2Actor> => ({
    accountId: (await options.identityRequests.authenticate(request)).account.id,
  });

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId",
    {
      schema: {
        description:
          "Read the authenticated organiser workspace, including private drafts and secret-free access metadata.",
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["competitions"],
      },
    },
    async (request) => options.runtime.competitionWorkspace(await readActor(request), request.params.competitionId),
  );

  app.post<{
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { organisation_id: string; name: string; slug: string; timezone: string; starts_on: string; ends_on: string };
  }>(
    "/api/v1/competitions",
    {
      schema: {
        description: "Create the Canoe Polo competition and recommended settings atomically.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        body: Type.Object({
          organisation_id: Id,
          name: Type.String({ minLength: 1, maxLength: 160 }),
          slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 120 }),
          timezone: Type.String({ minLength: 1, maxLength: 80 }),
          starts_on: Type.String({ format: "date" }),
          ends_on: Type.String({ format: "date" }),
        }),
        response: {
          201: GenericSuccess,
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
        },
        tags: ["competitions"],
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
            timezone: request.body.timezone,
            startsOn: request.body.starts_on,
            endsOn: request.body.ends_on,
          },
          request.id,
        ),
      ),
  );

  app.put<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: Record<string, unknown>;
  }>(
    "/api/v1/competitions/:competitionId/canoe-polo-settings",
    {
      schema: {
        description: "Customise the Canoe Polo settings before scoring starts.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object(
          {
            periodMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
            pointsWin: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
            pointsDraw: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
            pointsLoss: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
            tiebreakOrder: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 8 })),
          },
          { additionalProperties: false },
        ),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["competitions"],
      },
    },
    async (request) =>
      options.runtime.updateSettings(await actor(request), request.params.competitionId, request.body, request.id),
  );

  app.post<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body:
      | { name: string; team_limit: 8 | 16; idempotency_key: string }
      | { name: string; code?: string; entry_limit: 8 | 12 | 16 | 24 | 48; idempotency_key: string };
  }>(
    "/api/v1/competitions/:competitionId/divisions",
    {
      schema: {
        description: "Create a division using the backward-compatible Phase 2 or Phase 3 request shape.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 100 }),
            code: Type.Optional(Type.String()),
            team_limit: Type.Optional(Type.Union([Type.Literal(8), Type.Literal(16)])),
            entry_limit: Type.Optional(
              Type.Union([Type.Literal(8), Type.Literal(12), Type.Literal(16), Type.Literal(24), Type.Literal(48)]),
            ),
            idempotency_key: Type.String({ pattern: "^[A-Za-z0-9._:-]{8,200}$" }),
          },
          { additionalProperties: false },
        ),
        response: { 201: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["competitions"],
      },
    },
    async (request, reply) => {
      const authenticated = await actor(request);
      if (!options.phase3Runtime) throw new ApiError(503, "PHASE3_UNAVAILABLE", "Phase 3 runtime is unavailable");
      let entryLimit: 8 | 12 | 16 | 24 | 48;
      if ("entry_limit" in request.body) {
        if ("team_limit" in request.body) {
          throw new ApiError(400, "VALIDATION_ERROR", "Provide exactly one division limit");
        }
        entryLimit = request.body.entry_limit;
      } else if ("team_limit" in request.body) {
        entryLimit = request.body.team_limit;
      } else {
        throw new ApiError(400, "VALIDATION_ERROR", "Provide exactly one division limit");
      }
      return reply.code(201).send(
        await options.phase3Runtime.createDivision(
          authenticated,
          request.params.competitionId,
          {
            name: request.body.name,
            ...("code" in request.body && request.body.code ? { code: request.body.code } : {}),
            entryLimit,
          },
          request.id,
          request.body.idempotency_key,
        ),
      );
    },
  );

  app.put<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { entries: { name: string; seed: number }[] };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/entries",
    {
      schema: {
        description: "Replace the complete seeded entry list.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        body: Type.Object({
          entries: Type.Array(
            Type.Object({
              name: Type.String({ minLength: 1, maxLength: 120 }),
              seed: Type.Integer({ minimum: 1, maximum: 16 }),
            }),
            { minItems: 8, maxItems: 16 },
          ),
        }),
        response: {
          200: GenericSuccess,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["competitions"],
      },
    },
    async (request) =>
      options.runtime.replaceEntries(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.body.entries,
        request.id,
      ),
  );

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
        description: "Replace playing areas and separate continuous availability intervals.",
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
                  name: Type.String({ minLength: 1, maxLength: 80 }),
                  sort_order: Type.Optional(Type.Integer({ minimum: 0 })),
                  slot_minutes: Type.Integer({ minimum: 1, maximum: 1440 }),
                  fixed_reserve_slots: Type.Optional(Type.Integer({ minimum: 0 })),
                  availability: Type.Array(
                    Type.Object({
                      id: Type.Optional(Id),
                      date: Type.String({ format: "date" }),
                      start_time: Type.String(),
                      end_time: Type.String(),
                      cross_midnight: Type.Optional(Type.Boolean()),
                    }),
                  ),
                  unavailable: Type.Optional(
                    Type.Array(
                      Type.Object({
                        id: Type.Optional(Id),
                        date: Type.String({ format: "date" }),
                        start_time: Type.String(),
                        end_time: Type.String(),
                        cross_midnight: Type.Optional(Type.Boolean()),
                      }),
                    ),
                  ),
                },
                { additionalProperties: false },
              ),
              { maxItems: 64 },
            ),
          },
          { additionalProperties: false },
        ),
        response: {
          200: GenericSuccess,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["competitions"],
      },
    },
    async (request) => {
      const authenticated = await actor(request);
      if (!options.phase3Runtime) throw new ApiError(503, "PHASE3_UNAVAILABLE", "Phase 3 runtime is unavailable");
      return options.phase3Runtime.replaceCapacity(
        authenticated,
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
      );
    },
  );

  app.post<{
    Params: { competitionId: string; divisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/competitions/:competitionId/divisions/:divisionId/format-revisions/generate",
    {
      schema: {
        description: "Generate the idempotent balanced group-to-knockout graph.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, divisionId: Id }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
        tags: ["formats"],
      },
    },
    async (request) =>
      options.runtime.generateFormat(
        await actor(request),
        request.params.competitionId,
        request.params.divisionId,
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { format_revision_id: string };
  }>(
    "/api/v1/competitions/:competitionId/schedule-revisions/generate",
    {
      schema: {
        description: "Generate an isolated deterministic private schedule draft.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Object({ format_revision_id: Id }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
        tags: ["schedules"],
      },
    },
    async (request) =>
      options.runtime.generateSchedule(
        await actor(request),
        request.params.competitionId,
        request.body.format_revision_id,
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string; revisionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/competitions/:competitionId/schedule-revisions/:revisionId/publish",
    {
      schema: {
        description: "Publish one immutable schedule revision without changing the result version.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, revisionId: Id }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["schedules"],
      },
    },
    async (request) =>
      options.runtime.publishSchedule(
        await actor(request),
        request.params.competitionId,
        request.params.revisionId,
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string; matchId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { client_event_id: string; reason: string; expected_aggregate_version: number };
  }>(
    "/api/v1/competitions/:competitionId/matches/:matchId/reopen",
    {
      schema: {
        description: "Reopen a finalised match through an organiser-only append-only lifecycle event.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, matchId: Id }),
        body: Type.Object({
          client_event_id: Id,
          reason: Type.String({ minLength: 3, maxLength: 500 }),
          expected_aggregate_version: Type.Integer({ minimum: 1 }),
        }),
        response: {
          200: ResultMutationReceiptSchema,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["results"],
      },
    },
    async (request) =>
      options.runtime.reopenCanonicalMatch(
        await actor(request),
        request.params.competitionId,
        request.params.matchId,
        {
          clientEventId: request.body.client_event_id,
          reason: request.body.reason,
          expectedAggregateVersion: request.body.expected_aggregate_version,
        },
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string; matchId: string } }>(
    "/api/v1/competitions/:competitionId/matches/:matchId/scoring-audit",
    {
      schema: {
        description: "Read the canonical score stream, projection, audit history, and downstream conflicts.",
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id, matchId: Id }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["results", "audit"],
      },
    },
    async (request) =>
      options.runtime.matchScoringAudit(await readActor(request), request.params.competitionId, request.params.matchId),
  );

  app.get<{ Params: { competitionId: string }; Querystring: { status?: string } }>(
    "/api/v1/competitions/:competitionId/result-conflicts",
    {
      schema: {
        description: "List retained downstream result conflicts without exposing scoring credentials.",
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union([Type.Literal("open"), Type.Literal("acknowledged"), Type.Literal("resolved")]),
          ),
        }),
        response: { 200: Type.Array(GenericSuccess), 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
        tags: ["results"],
      },
    },
    async (request) =>
      options.runtime.listResultConflicts(
        await readActor(request),
        request.params.competitionId,
        request.query.status ?? null,
      ),
  );

  app.post<{
    Params: { competitionId: string; conflictId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { client_event_id: string; reason: string; expected_revision: number };
  }>(
    "/api/v1/competitions/:competitionId/result-conflicts/:conflictId/acknowledge",
    {
      schema: {
        description: "Acknowledge a retained downstream result conflict without altering match participants.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, conflictId: Id }),
        body: Type.Object({
          client_event_id: Id,
          reason: Type.String({ minLength: 3, maxLength: 1000 }),
          expected_revision: Type.Integer({ minimum: 1 }),
        }),
        response: {
          200: GenericSuccess,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["results"],
      },
    },
    async (request) =>
      options.runtime.acknowledgeResultConflict(
        await actor(request),
        request.params.competitionId,
        request.params.conflictId,
        {
          clientEventId: request.body.client_event_id,
          reason: request.body.reason,
          expectedRevision: request.body.expected_revision,
        },
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string; matchId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { expires_at: string; role: "scorekeeper" | "viewer"; idempotency_key: string };
  }>(
    "/api/v1/competitions/:competitionId/matches/:matchId/access-passes",
    {
      schema: {
        description: "Issue a match-bound scoring QR token and short code. Secrets are returned once.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, matchId: Id }),
        body: Type.Object(
          {
            expires_at: Type.String({ format: "date-time" }),
            role: Type.Union([Type.Literal("scorekeeper"), Type.Literal("viewer")]),
            idempotency_key: Type.String({ minLength: 8, maxLength: 160 }),
          },
          { additionalProperties: false },
        ),
        response: { 201: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.createAccessPass(
          await actor(request),
          request.params.competitionId,
          request.params.matchId,
          {
            expiresAt: request.body.expires_at,
            role: request.body.role,
            idempotencyKey: request.body.idempotency_key,
          },
          request.id,
        ),
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/access-passes",
    {
      schema: {
        description: "List secret-free scoring access passes for an organiser.",
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request) => ({
      access_passes: await options.runtime.listAccessPasses(await readActor(request), request.params.competitionId),
    }),
  );

  app.post<{
    Params: { competitionId: string; passId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { idempotency_key: string };
  }>(
    "/api/v1/competitions/:competitionId/access-passes/:passId/fallback-code/rotate",
    {
      schema: {
        description: "Rotate and reveal a fallback number code once.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, passId: Id }),
        body: Type.Object({ idempotency_key: Type.String({ minLength: 8, maxLength: 160 }) }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request) =>
      options.runtime.rotateFallbackCode(
        await actor(request),
        request.params.competitionId,
        request.params.passId,
        request.body.idempotency_key,
        request.id,
      ),
  );

  app.delete<{
    Params: { competitionId: string; passId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { reason?: string };
  }>(
    "/api/v1/competitions/:competitionId/access-passes/:passId",
    {
      schema: {
        description: "Revoke an access pass and every derived scoring session.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, passId: Id }),
        body: Type.Optional(Type.Object({ reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })) })),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request) =>
      options.runtime.revokeAccessPass(
        await actor(request),
        request.params.competitionId,
        request.params.passId,
        request.id,
        request.body?.reason ?? null,
      ),
  );

  app.post<{
    Body: {
      token?: string;
      short_code?: string;
      expected_match_id?: string;
      device_id: string;
      device_label?: string;
    };
  }>(
    "/api/v1/scoring/access/exchange",
    {
      config: { rateLimit: false },
      schema: {
        description:
          "Exchange a QR token or number code in the request body for a short-lived writer session. The secret never appears in the URL.",
        body: Type.Object(
          {
            token: Type.Optional(Type.String({ minLength: 32, maxLength: 256 })),
            short_code: Type.Optional(Type.String({ pattern: "^[0-9]{12}$" })),
            expected_match_id: Type.Optional(Id),
            device_id: Type.String({ minLength: 32, maxLength: 256 }),
            device_label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: GenericSuccess,
          400: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
        tags: ["scoring-access"],
      },
    },
    async (request, reply) => {
      try {
        const result = await options.runtime.exchangeAccess(
          {
            ...(request.body.token ? { token: request.body.token } : {}),
            ...(request.body.short_code ? { shortCode: request.body.short_code } : {}),
            ...(request.body.expected_match_id ? { expectedMatchId: request.body.expected_match_id } : {}),
            deviceId: request.body.device_id,
            ...(request.body.device_label ? { deviceLabel: request.body.device_label } : {}),
            ipAddress: request.ip,
          },
          request.id,
        );
        setAccessRateLimitHeaders(reply, result.rate_limit);
        return result;
      } catch (error) {
        if (error instanceof ScoringAccessRateLimitError || error instanceof ScoringAccessRejectedError) {
          setAccessRateLimitHeaders(reply, error.rateLimit);
        }
        throw error;
      }
    },
  );

  app.post<{ Headers: ScoringHeaderValues }>(
    "/api/v1/scoring/sessions/transfer",
    {
      schema: {
        description:
          "Deprecated self-transfer endpoint. Always rejects; candidates must request organiser-approved takeover.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        response: { 200: GenericSuccess, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["scoring"],
      },
    },
    async (request) => options.runtime.transferWriter(scoringAuth(request.headers), request.id),
  );

  app.post<{
    Headers: ScoringHeaderValues;
    Body: {
      last_acknowledged_sequence: number;
      pending_event_count: number;
      pending_through_sequence: number;
    };
  }>(
    "/api/v1/scoring/sessions/heartbeat",
    {
      schema: {
        description: "Renew an authoritative scoring session and, for the active writer, its short lease.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        body: Type.Object({
          last_acknowledged_sequence: Type.Integer({ minimum: 0 }),
          pending_event_count: Type.Integer({ minimum: 0 }),
          pending_through_sequence: Type.Integer({ minimum: 0 }),
        }),
        response: { 200: GenericSuccess, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request) =>
      options.runtime.heartbeatScoringSession(
        scoringAuth(request.headers),
        {
          lastAcknowledgedSequence: request.body.last_acknowledged_sequence,
          pendingEventCount: request.body.pending_event_count,
          pendingThroughSequence: request.body.pending_through_sequence,
        },
        request.id,
      ),
  );

  app.post<{
    Headers: ScoringHeaderValues;
    Body: { pending_event_count: number; pending_through_sequence: number };
  }>(
    "/api/v1/scoring/takeover-requests",
    {
      schema: {
        description: "Request organiser approval for a candidate device to take the writer lease.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        body: Type.Object({
          pending_event_count: Type.Integer({ minimum: 0 }),
          pending_through_sequence: Type.Integer({ minimum: 0 }),
        }),
        response: { 201: GenericSuccess, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.requestTakeover(
          scoringAuth(request.headers),
          {
            pendingEventCount: request.body.pending_event_count,
            pendingThroughSequence: request.body.pending_through_sequence,
          },
          request.id,
        ),
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/takeover-requests",
    {
      schema: {
        description: "List scoring takeover requests for organiser review.",
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: Type.Array(GenericSuccess), 401: ErrorResponse, 403: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request) => options.runtime.listTakeoverRequests(await readActor(request), request.params.competitionId),
  );

  app.post<{
    Params: { competitionId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/competitions/:competitionId/takeover-requests/expire",
    {
      schema: {
        description: "Explicitly transition elapsed takeover requests and record their audit/outbox evidence.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        response: { 200: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request) =>
      options.runtime.expireTakeoverRequests(await actor(request), request.params.competitionId, request.id),
  );

  for (const decision of ["approve", "deny"] as const) {
    app.post<{
      Params: { competitionId: string; requestId: string };
      Headers: { origin?: string; "x-csrf-token"?: string };
      Body: { override_acknowledged?: boolean; reason: string };
    }>(
      `/api/v1/competitions/:competitionId/takeover-requests/:requestId/${decision}`,
      {
        schema: {
          description: `${decision === "approve" ? "Approve" : "Deny"} a scoring writer takeover request.`,
          security: [{ sessionCookie: [] }],
          headers: MutationHeaders,
          params: Type.Object({ competitionId: Id, requestId: Id }),
          body: Type.Object({
            override_acknowledged: Type.Optional(Type.Boolean()),
            reason: Type.String({ minLength: 3, maxLength: 500 }),
          }),
          response: {
            200: GenericSuccess,
            401: ErrorResponse,
            403: ErrorResponse,
            409: ErrorResponse,
            422: ErrorResponse,
          },
          tags: ["scoring-access"],
        },
      },
      async (request) =>
        options.runtime.resolveTakeover(
          await actor(request),
          request.params.competitionId,
          request.params.requestId,
          {
            decision,
            overrideAcknowledged: request.body.override_acknowledged ?? false,
            reason: request.body.reason,
          },
          request.id,
        ),
    );
  }

  app.get<{ Headers: ScoringHeaderValues }>(
    "/api/v1/scoring/session",
    {
      schema: {
        description:
          "Recover the server-confirmed competition destination, match, score-event stream, writer generation, and expiry without exposing access secrets.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        response: { 200: ScoringSessionStateSchema, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["scoring"],
      },
    },
    async (request) => options.runtime.scoringSessionState(scoringAuth(request.headers)),
  );

  app.post<{
    Headers: ScoringHeaderValues;
    Body: {
      client_event_id: string;
      expected_sequence: number;
      type: string;
      team_slot?: "home" | "away";
      participant_id?: string;
      unknown_participant?: boolean;
      segment_number?: number;
      manual_time_seconds?: number | null;
      reversal_target_event_id?: string;
      reason?: string;
      occurred_at: string;
    };
  }>(
    "/api/v1/scoring/events",
    {
      schema: {
        description: "Append one canonical, idempotent five-sport score event using the active fencing generation.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        body: Type.Object(
          {
            client_event_id: Id,
            expected_sequence: Type.Integer({ minimum: 0 }),
            type: Type.String({ minLength: 1, maxLength: 80 }),
            team_slot: Type.Optional(Type.Union([Type.Literal("home"), Type.Literal("away")])),
            participant_id: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            unknown_participant: Type.Optional(Type.Boolean()),
            segment_number: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
            manual_time_seconds: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 3599 }), Type.Null()])),
            reversal_target_event_id: Type.Optional(Id),
            reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
            occurred_at: Type.String({ format: "date-time" }),
          },
          { additionalProperties: false },
        ),
        response: {
          200: GenericSuccess,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["scoring"],
      },
    },
    async (request) => {
      return options.runtime.appendCanonicalScoreEvent(
        scoringAuth(request.headers),
        {
          client_event_id: request.body.client_event_id,
          type: request.body.type,
          occurred_at: request.body.occurred_at,
          ...(request.body.team_slot ? { team_slot: request.body.team_slot } : {}),
          ...(request.body.participant_id ? { participant_id: request.body.participant_id } : {}),
          ...(request.body.unknown_participant !== undefined
            ? { unknown_participant: request.body.unknown_participant }
            : {}),
          ...(request.body.segment_number ? { segment_number: request.body.segment_number } : {}),
          ...(request.body.manual_time_seconds !== undefined
            ? { manual_time_seconds: request.body.manual_time_seconds }
            : {}),
          ...(request.body.reversal_target_event_id
            ? { reversal_target_event_id: request.body.reversal_target_event_id }
            : {}),
          ...(request.body.reason ? { reason: request.body.reason } : {}),
        },
        request.body.expected_sequence,
        request.id,
      );
    },
  );

  app.post<{ Headers: ScoringHeaderValues; Body: { client_event_id: string; expected_sequence: number } }>(
    "/api/v1/scoring/finalise",
    {
      schema: {
        description:
          "Atomically finalise the match, recalculate table and bracket, publish results, audit, and enqueue outbox work.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        body: Type.Object({
          client_event_id: Id,
          expected_sequence: Type.Integer({ minimum: 0 }),
        }),
        response: {
          200: ScoringFinalisationReceiptSchema,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["scoring"],
      },
    },
    async (request) =>
      options.runtime.finalise(
        scoringAuth(request.headers),
        request.body.client_event_id,
        request.id,
        request.body.expected_sequence,
      ),
  );

  app.post<{
    Params: { competitionId: string; matchId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: {
      client_event_id: string;
      reason: string;
      expected_aggregate_version: number;
      events: unknown[];
    };
  }>(
    "/api/v1/competitions/:competitionId/matches/:matchId/corrections",
    {
      schema: {
        description:
          "Atomically reopen, append reasoned canonical correction events, finalise, publish, and retain downstream conflicts.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, matchId: Id }),
        body: Type.Object({
          client_event_id: Id,
          reason: Type.String({ minLength: 3, maxLength: 500 }),
          expected_aggregate_version: Type.Integer({ minimum: 1 }),
          events: Type.Array(Type.Record(Type.String(), Type.Any()), { minItems: 1, maxItems: 25 }),
        }),
        response: {
          200: ResultMutationReceiptSchema,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["results"],
      },
    },
    async (request) =>
      options.runtime.correctCanonicalMatch(
        await actor(request),
        request.params.competitionId,
        request.params.matchId,
        {
          clientEventId: request.body.client_event_id,
          reason: request.body.reason,
          expectedAggregateVersion: request.body.expected_aggregate_version,
          events: request.body.events,
        },
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/audit",
    {
      schema: {
        description: "Read the append-only competition audit timeline.",
        security: [{ sessionCookie: [] }],
        params: Type.Object({ competitionId: Id }),
        response: { 200: Type.Array(GenericSuccess), 401: ErrorResponse, 403: ErrorResponse },
        tags: ["audit"],
      },
    },
    async (request) => {
      const session = await options.identityRequests.authenticate(request);
      return options.runtime.audit({ accountId: session.account.id }, request.params.competitionId);
    },
  );

  app.get<{ Params: { slug: string } }>(
    "/api/v1/public/competitions/:slug",
    {
      schema: {
        description:
          "Read only the current matched schedule/result projection. Draft revisions and private contacts are excluded.",
        params: Type.Object({ slug: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 120 }) }),
        response: { 200: PublicCompetitionSchema, 404: ErrorResponse },
        tags: ["public"],
      },
    },
    async (request) => options.runtime.publicCompetition(request.params.slug),
  );
}
