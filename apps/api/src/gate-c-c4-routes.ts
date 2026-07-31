import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { GateCC4LifecycleOperations } from "./gate-c-c4-lifecycle.js";
import type { GateCC4Operations } from "./gate-c-c4-operations.js";
import type { GateCC4Runtime } from "./gate-c-c4-runtime.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

const Id = Type.String({ format: "uuid" });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const IdempotencyKey = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,200}$" });
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const MutationHeaders = Type.Object(
  { origin: Type.String({ minLength: 1 }), "x-csrf-token": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const AnalysisBody = strict({ correction_transaction_id: Id });
const DecisionBody = strict({
  client_event_id: Id,
  match_id: Id,
  slot: Type.Union([Type.Literal("home"), Type.Literal("away")]),
  decision: Type.Union([
    Type.Literal("accept_proposed"),
    Type.Literal("keep_current"),
    Type.Literal("set_manual_entry"),
    Type.Literal("leave_protected"),
  ]),
  selected_entry_id: Type.Optional(Type.Union([Id, Type.Null()])),
  reason: Type.String({ minLength: 3, maxLength: 1_000 }),
});
const AdjustmentBody = strict({
  match_id: Id,
  division_id: Id,
  starts_at: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
  ends_at: Type.Optional(Type.Union([Type.String({ format: "date-time" }), Type.Null()])),
  playing_area_id: Type.Optional(Type.Union([Id, Type.Null()])),
  reason: Type.String({ minLength: 3, maxLength: 1_000 }),
});
const RevisionBody = strict({
  parent_revision_id: Type.Union([Id, Type.Null()]),
  expected_result_version: Type.Integer({ minimum: 1 }),
  expected_schedule_version: Type.Integer({ minimum: 0 }),
  expected_analysis_fingerprint: Sha256,
  status: Type.Union([Type.Literal("draft"), Type.Literal("ready")]),
  decisions: Type.Array(DecisionBody, { maxItems: 10_000 }),
  schedule_adjustments: Type.Array(AdjustmentBody, { maxItems: 10_000 }),
});
const PublicationBody = strict({
  competition_id: Id,
  repair_id: Id,
  repair_revision_id: Id,
  expected_schedule_version: Type.Integer({ minimum: 0 }),
  expected_result_version: Type.Integer({ minimum: 1 }),
  expected_analysis_fingerprint: Sha256,
  publication_idempotency_key: IdempotencyKey,
});
const AbandonBody = strict({
  expected_revision: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 3, maxLength: 1_000 }),
});
const RepairQueueItem = strict({
  repair_id: Id,
  corrected_match_id: Id,
  corrected_match_code: Type.String({ minLength: 1 }),
  division_id: Id,
  division_name: Type.String({ minLength: 1 }),
  source_result_version: Type.Integer({ minimum: 1 }),
  source_schedule_version: Type.Integer({ minimum: 0 }),
  source_projection_version: Type.Integer({ minimum: 0 }),
  analysis_fingerprint: Sha256,
  latest_revision_id: Type.Union([Id, Type.Null()]),
  latest_revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  latest_status: Type.Union([
    Type.Literal("draft"),
    Type.Literal("ready"),
    Type.Literal("published"),
    Type.Literal("abandoned"),
    Type.Null(),
  ]),
  affected_action_count: Type.Integer({ minimum: 0 }),
  unresolved_action_count: Type.Integer({ minimum: 0 }),
  created_at: Type.String({ format: "date-time" }),
});

function rejectUnknownBodyFields(allowed: readonly string[]) {
  const expected = new Set(allowed);
  return async (request: FastifyRequest) => {
    const body = request.body;
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).some((field) => !expected.has(field))
    ) {
      throw new ApiError(400, "REQUEST_INVALID", "Request body contains an unknown field");
    }
  };
}

export async function registerGateCC4Routes(
  app: FastifyInstance,
  options: {
    runtime: GateCC4Runtime;
    operations: GateCC4Operations;
    lifecycle: GateCC4LifecycleOperations;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
  },
): Promise<void> {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await options.identityRequests.authenticate(request);
    return { accountId: session.account.id };
  };
  const mutationActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
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

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/repairs",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: strict({ competitionId: Id }),
        response: { 200: Type.Array(RepairQueueItem), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["gate-c-c4"],
      },
    },
    async (request) => options.operations.listRepairs(await readActor(request), request.params.competitionId),
  );

  app.post<{
    Params: { competitionId: string };
    Body: Static<typeof AnalysisBody>;
  }>(
    "/api/v1/competitions/:competitionId/repairs/analyse",
    {
      preValidation: rejectUnknownBodyFields(["correction_transaction_id"]),
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id }),
        body: AnalysisBody,
        response: {
          200: Type.Unknown(),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["gate-c-c4"],
      },
    },
    async (request) =>
      options.runtime.analyseCorrection(
        await mutationActor(request),
        request.params.competitionId,
        request.body.correction_transaction_id,
        request.id,
      ),
  );

  app.get<{ Params: { competitionId: string; repairId: string } }>(
    "/api/v1/competitions/:competitionId/repairs/:repairId",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        params: strict({ competitionId: Id, repairId: Id }),
        response: { 200: Type.Unknown(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse },
        tags: ["gate-c-c4"],
      },
    },
    async (request) =>
      options.runtime.readWorkspace(await readActor(request), request.params.competitionId, request.params.repairId),
  );

  app.post<{
    Params: { competitionId: string; repairId: string };
    Body: Static<typeof RevisionBody>;
  }>(
    "/api/v1/competitions/:competitionId/repairs/:repairId/revisions",
    {
      preValidation: rejectUnknownBodyFields([
        "parent_revision_id",
        "expected_result_version",
        "expected_schedule_version",
        "expected_analysis_fingerprint",
        "status",
        "decisions",
        "schedule_adjustments",
      ]),
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id, repairId: Id }),
        body: RevisionBody,
        response: {
          201: Type.Unknown(),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["gate-c-c4"],
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await options.runtime.createRevision(
          await mutationActor(request),
          request.params.competitionId,
          request.params.repairId,
          request.body,
          request.id,
        ),
      ),
  );

  app.post<{
    Params: { competitionId: string; repairId: string; revisionId: string };
    Body: Static<typeof PublicationBody>;
  }>(
    "/api/v1/competitions/:competitionId/repairs/:repairId/revisions/:revisionId/publish",
    {
      preValidation: rejectUnknownBodyFields([
        "competition_id",
        "repair_id",
        "repair_revision_id",
        "expected_schedule_version",
        "expected_result_version",
        "expected_analysis_fingerprint",
        "publication_idempotency_key",
      ]),
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id, repairId: Id, revisionId: Id }),
        body: PublicationBody,
        response: {
          200: Type.Unknown(),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["gate-c-c4"],
      },
    },
    async (request) => {
      if (
        request.body.competition_id !== request.params.competitionId ||
        request.body.repair_id !== request.params.repairId ||
        request.body.repair_revision_id !== request.params.revisionId
      ) {
        throw new ApiError(400, "REQUEST_INVALID", "Publication path and body identifiers must match");
      }
      return options.runtime.publishRevision(await mutationActor(request), request.body, request.id);
    },
  );

  app.post<{
    Params: { competitionId: string; repairId: string };
    Body: Static<typeof AbandonBody>;
  }>(
    "/api/v1/competitions/:competitionId/repairs/:repairId/abandon",
    {
      preValidation: rejectUnknownBodyFields(["expected_revision", "reason"]),
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id, repairId: Id }),
        body: AbandonBody,
        response: {
          200: Type.Unknown(),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
        },
        tags: ["gate-c-c4"],
      },
    },
    async (request) =>
      options.lifecycle.abandonLatestRevision(
        await mutationActor(request),
        request.params.competitionId,
        request.params.repairId,
        request.body,
        request.id,
      ),
  );

  app.post<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/exports/schedule",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id }),
        response: { 200: Type.Any(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
        tags: ["gate-c-c4"],
      },
    },
    async (request, reply) => {
      const receipt = await options.operations.schedulePdf(await mutationActor(request), request.params.competitionId);
      return reply
        .type(receipt.contentType)
        .header("content-disposition", `attachment; filename=\"${receipt.filename}\"`)
        .header("x-matchday-content-sha256", receipt.sha256)
        .header("x-matchday-source-fingerprint", receipt.sourceFingerprint)
        .header("x-matchday-schedule-version", String(receipt.scheduleVersion))
        .header("x-matchday-result-version", String(receipt.resultVersion))
        .header("x-matchday-export-manifest-id", receipt.manifestId)
        .header("x-matchday-idempotent-replay", String(receipt.duplicate))
        .send(Buffer.from(receipt.bytes));
    },
  );

  app.post<{ Params: { competitionId: string; matchId: string } }>(
    "/api/v1/competitions/:competitionId/exports/matches/:matchId/score-sheet",
    {
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id, matchId: Id }),
        response: { 200: Type.Any(), 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse },
        tags: ["gate-c-c4"],
      },
    },
    async (request, reply) => {
      const receipt = await options.operations.scoreSheetPdf(
        await mutationActor(request),
        request.params.competitionId,
        request.params.matchId,
      );
      return reply
        .type(receipt.contentType)
        .header("content-disposition", `attachment; filename=\"${receipt.filename}\"`)
        .header("x-matchday-content-sha256", receipt.sha256)
        .header("x-matchday-source-fingerprint", receipt.sourceFingerprint)
        .header("x-matchday-schedule-version", String(receipt.scheduleVersion))
        .header("x-matchday-result-version", String(receipt.resultVersion))
        .header("x-matchday-export-manifest-id", receipt.manifestId)
        .header("x-matchday-idempotent-replay", String(receipt.duplicate))
        .send(Buffer.from(receipt.bytes));
    },
  );
}
