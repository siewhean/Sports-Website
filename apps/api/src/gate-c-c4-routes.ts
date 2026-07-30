import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import type { GateCC4Runtime } from "./gate-c-c4-runtime.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { Phase3Actor } from "./phase-3-runtime.js";

const Id = Type.String({ format: "uuid" });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const IdempotencyKey = Type.String({ pattern: "^[A-Za-z0-9._:-]{8,200}$" });
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const Json = Type.Unknown();
const MutationHeaders = Type.Object(
  { origin: Type.String({ minLength: 1 }), "x-csrf-token": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
const ErrorResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
  503: ErrorResponse,
};

function strict<T extends Record<string, ReturnType<typeof Type.Any>>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const Decision = strict({
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

const ScheduleAdjustment = strict({
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
  expected_analysis_fingerprint: Hash,
  status: Type.Union([Type.Literal("draft"), Type.Literal("ready")]),
  decisions: Type.Array(Decision, { maxItems: 2_256 }),
  schedule_adjustments: Type.Array(ScheduleAdjustment, { maxItems: 1_128 }),
});

const PublishBody = strict({
  expected_schedule_version: Type.Integer({ minimum: 0 }),
  expected_result_version: Type.Integer({ minimum: 1 }),
  expected_analysis_fingerprint: Hash,
  publication_idempotency_key: IdempotencyKey,
});

export async function registerGateCC4Routes(
  app: FastifyInstance,
  options: {
    runtime: GateCC4Runtime;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
  },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => ({
    accountId: (await options.identityRequests.authenticate(request)).account.id,
  });
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
  const read = { security: [{ sessionCookie: [] }], response: { 200: Json, ...ErrorResponses } };
  const mutation = { security: [{ sessionCookie: [] }], headers: MutationHeaders };

  app.post<{
    Params: { competitionId: string };
    Body: { correction_transaction_id: string };
  }>(
    "/api/v1/competitions/:competitionId/repairs/analyse",
    {
      schema: {
        ...mutation,
        params: strict({ competitionId: Id }),
        body: strict({ correction_transaction_id: Id }),
        response: { 201: Json, ...ErrorResponses },
        tags: ["gate-c-repairs"],
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await options.runtime.analyseCorrection(
            await mutationActor(request),
            request.params.competitionId,
            request.body.correction_transaction_id,
            request.id,
          ),
        ),
  );

  app.get<{ Params: { competitionId: string; repairId: string } }>(
    "/api/v1/competitions/:competitionId/repairs/:repairId",
    {
      schema: {
        ...read,
        params: strict({ competitionId: Id, repairId: Id }),
        tags: ["gate-c-repairs"],
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
      schema: {
        ...mutation,
        params: strict({ competitionId: Id, repairId: Id }),
        body: RevisionBody,
        response: { 201: Json, ...ErrorResponses },
        tags: ["gate-c-repairs"],
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
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
    Body: Static<typeof PublishBody>;
  }>(
    "/api/v1/competitions/:competitionId/repairs/:repairId/revisions/:revisionId/publish",
    {
      schema: {
        ...mutation,
        params: strict({ competitionId: Id, repairId: Id, revisionId: Id }),
        body: PublishBody,
        response: { 200: Json, ...ErrorResponses },
        tags: ["gate-c-repairs"],
      },
    },
    async (request) =>
      options.runtime.publishRevision(
        await mutationActor(request),
        {
          competition_id: request.params.competitionId,
          repair_id: request.params.repairId,
          repair_revision_id: request.params.revisionId,
          expected_schedule_version: request.body.expected_schedule_version,
          expected_result_version: request.body.expected_result_version,
          expected_analysis_fingerprint: request.body.expected_analysis_fingerprint,
          publication_idempotency_key: request.body.publication_idempotency_key,
        },
        request.id,
      ),
  );
}
