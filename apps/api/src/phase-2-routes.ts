import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { PersistedScoreEvent, Phase2Actor, Phase2Runtime } from "./phase-2-runtime.js";
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
  "x-writer-generation": Type.String({ pattern: "^[1-9][0-9]*$" }),
});
const GenericSuccess = Type.Record(Type.String(), Type.Any());
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
const PublicCompetitionSchema = Type.Object({
  competition: Type.Object({
    id: Id,
    name: Type.String(),
    slug: Type.String(),
    sport_code: Type.Literal("canoe_polo"),
    timezone: Type.String(),
    starts_on: Type.String({ format: "date" }),
    ends_on: Type.String({ format: "date" }),
    status: Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("archived")]),
  }),
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
    generation: Type.Integer({ minimum: 1 }),
    expires_at: Type.String({ format: "date-time" }),
    read_only: Type.Boolean(),
  }),
  score: Type.Object({
    home: Type.Integer({ minimum: 0 }),
    away: Type.Integer({ minimum: 0 }),
  }),
  through_sequence: Type.Integer({ minimum: 0 }),
  events: Type.Array(
    Type.Object({
      client_event_id: Id,
      sequence: Type.Integer({ minimum: 1 }),
      type: Type.Union([
        Type.Literal("match_started"),
        Type.Literal("period_changed"),
        Type.Literal("goal_added"),
        Type.Literal("goal_reversed"),
        Type.Literal("card_added"),
        Type.Literal("card_reversed"),
        Type.Literal("timeout_added"),
        Type.Literal("incident_added"),
        Type.Literal("match_finalised"),
        Type.Literal("match_reopened"),
        Type.Literal("correction"),
      ]),
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
  "x-writer-generation": string;
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
    generation: Number(headers["x-writer-generation"]),
  };
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
    Body: { name: string; team_limit: 8 | 16 } | { name: string; code?: string; entry_limit: 8 | 12 | 16 | 24 | 48 };
  }>(
    "/api/v1/competitions/:competitionId/divisions",
    {
      schema: {
        description: "Create a division using the backward-compatible Phase 2 or Phase 3 request shape.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id }),
        body: Type.Union([
          Type.Object(
            {
              name: Type.String({ minLength: 1, maxLength: 100 }),
              team_limit: Type.Union([Type.Literal(8), Type.Literal(16)]),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              name: Type.String({ minLength: 1, maxLength: 100 }),
              code: Type.Optional(Type.String()),
              entry_limit: Type.Union([
                Type.Literal(8),
                Type.Literal(12),
                Type.Literal(16),
                Type.Literal(24),
                Type.Literal(48),
              ]),
            },
            { additionalProperties: false },
          ),
        ]),
        response: { 201: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["competitions"],
      },
    },
    async (request, reply) => {
      const authenticated = await actor(request);
      if ("entry_limit" in request.body) {
        if (!options.phase3Runtime) throw new ApiError(503, "PHASE3_UNAVAILABLE", "Phase 3 runtime is unavailable");
        return reply.code(201).send(
          await options.phase3Runtime.createDivision(
            authenticated,
            request.params.competitionId,
            {
              name: request.body.name,
              ...(request.body.code ? { code: request.body.code } : {}),
              entryLimit: request.body.entry_limit,
            },
            request.id,
          ),
        );
      }
      return reply
        .code(201)
        .send(
          await options.runtime.createDivision(
            authenticated,
            request.params.competitionId,
            { name: request.body.name, teamLimit: request.body.team_limit },
            request.id,
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
    Body: { expires_at: string };
  }>(
    "/api/v1/competitions/:competitionId/matches/:matchId/access-passes",
    {
      schema: {
        description: "Issue a match-bound scoring QR token and short code. Secrets are returned once.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, matchId: Id }),
        body: Type.Object({ expires_at: Type.String({ format: "date-time" }) }),
        response: { 201: GenericSuccess, 401: ErrorResponse, 403: ErrorResponse, 422: ErrorResponse },
        tags: ["scoring-access"],
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await options.runtime.createAccessPass(
            await actor(request),
            request.params.competitionId,
            request.params.matchId,
            request.body.expires_at,
            request.id,
          ),
        ),
  );

  app.delete<{
    Params: { competitionId: string; passId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
  }>(
    "/api/v1/competitions/:competitionId/access-passes/:passId",
    {
      schema: {
        description: "Revoke an access pass and every derived scoring session.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, passId: Id }),
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
      ),
  );

  app.post<{ Body: { token?: string; short_code?: string; expected_match_id?: string } }>(
    "/api/v1/scoring/access/exchange",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        description:
          "Exchange a QR token or number code in the request body for a short-lived writer session. The secret never appears in the URL.",
        body: Type.Object(
          {
            token: Type.Optional(Type.String({ minLength: 32, maxLength: 256 })),
            short_code: Type.Optional(Type.String({ pattern: "^[0-9]{12}$" })),
            expected_match_id: Type.Optional(Id),
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
    async (request) =>
      options.runtime.exchangeAccess(
        {
          ...(request.body.token ? { token: request.body.token } : {}),
          ...(request.body.short_code ? { shortCode: request.body.short_code } : {}),
          ...(request.body.expected_match_id ? { expectedMatchId: request.body.expected_match_id } : {}),
        },
        request.id,
      ),
  );

  app.post<{ Headers: ScoringHeaderValues }>(
    "/api/v1/scoring/sessions/transfer",
    {
      schema: {
        description: "Explicitly transfer the active writer lease and fence the previous session.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        response: { 200: GenericSuccess, 403: ErrorResponse, 409: ErrorResponse },
        tags: ["scoring"],
      },
    },
    async (request) => options.runtime.transferWriter(scoringAuth(request.headers), request.id),
  );

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
      type: PersistedScoreEvent["type"];
      team_slot?: "home" | "away";
      scorer?: string;
      manual_period: 1 | 2;
      manual_event_seconds: number;
      payload?: Record<string, unknown>;
      correction_reason?: string;
      occurred_at: string;
    };
  }>(
    "/api/v1/scoring/events",
    {
      schema: {
        description: "Append one idempotent Canoe Polo score event using the active fencing generation.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        body: Type.Object(
          {
            client_event_id: Id,
            type: Type.Union([
              Type.Literal("match_started"),
              Type.Literal("period_changed"),
              Type.Literal("goal_added"),
              Type.Literal("goal_reversed"),
              Type.Literal("card_added"),
              Type.Literal("card_reversed"),
              Type.Literal("timeout_added"),
              Type.Literal("incident_added"),
              Type.Literal("match_reopened"),
            ]),
            team_slot: Type.Optional(Type.Union([Type.Literal("home"), Type.Literal("away")])),
            scorer: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
            manual_period: Type.Union([Type.Literal(1), Type.Literal(2)]),
            manual_event_seconds: Type.Integer({ minimum: 0, maximum: 3599 }),
            payload: Type.Optional(Type.Record(Type.String(), Type.Any())),
            correction_reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
            occurred_at: Type.String({ format: "date-time" }),
          },
          { additionalProperties: false },
        ),
        response: { 200: GenericSuccess, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["scoring"],
      },
    },
    async (request) =>
      options.runtime.appendScoreEvent(
        scoringAuth(request.headers),
        {
          clientEventId: request.body.client_event_id,
          type: request.body.type,
          teamSlot: request.body.team_slot ?? null,
          scorer: request.body.scorer ?? null,
          manualPeriod: request.body.manual_period,
          manualEventSeconds: request.body.manual_event_seconds,
          payload: request.body.payload ?? {},
          correctionReason: request.body.correction_reason ?? null,
          occurredAt: new Date(request.body.occurred_at),
        },
        request.id,
      ),
  );

  app.post<{ Headers: ScoringHeaderValues; Body: { client_event_id: string } }>(
    "/api/v1/scoring/finalise",
    {
      schema: {
        description:
          "Atomically finalise the match, recalculate table and bracket, publish results, audit, and enqueue outbox work.",
        headers: ScoringHeaders,
        security: [{ scoringSession: [] }],
        body: Type.Object({ client_event_id: Id }),
        response: { 200: GenericSuccess, 403: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
        tags: ["scoring"],
      },
    },
    async (request) => options.runtime.finalise(scoringAuth(request.headers), request.body.client_event_id, request.id),
  );

  app.post<{
    Params: { competitionId: string; matchId: string };
    Headers: { origin?: string; "x-csrf-token"?: string };
    Body: { client_event_id: string; reason: string; home_score: number; away_score: number };
  }>(
    "/api/v1/competitions/:competitionId/matches/:matchId/corrections",
    {
      schema: {
        description: "Append a reasoned correction unless a final downstream result would be invalidated.",
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: Type.Object({ competitionId: Id, matchId: Id }),
        body: Type.Object({
          client_event_id: Id,
          reason: Type.String({ minLength: 3, maxLength: 500 }),
          home_score: Type.Integer({ minimum: 0 }),
          away_score: Type.Integer({ minimum: 0 }),
        }),
        response: {
          200: GenericSuccess,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["results"],
      },
    },
    async (request) =>
      options.runtime.correct(
        await actor(request),
        request.params.competitionId,
        request.params.matchId,
        {
          clientEventId: request.body.client_event_id,
          reason: request.body.reason,
          homeScore: request.body.home_score,
          awayScore: request.body.away_score,
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
