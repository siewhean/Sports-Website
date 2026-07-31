import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import { registerGateCC4Routes } from "./gate-c-c4-routes.js";
import type { GateCC4LifecycleOperations } from "./gate-c-c4-lifecycle.js";
import type { GateCC4Operations } from "./gate-c-c4-operations.js";
import type { GateCC4Runtime } from "./gate-c-c4-runtime.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { IdentityApiRuntime } from "./identity-runtime.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { GateBPhase4Runtime } from "./phase-4-gate-b-runtime.js";
import type { ReliableGateBPhase4Runtime } from "./phase-4-reliable-runtime.js";

const Id = Type.String({ format: "uuid" });
const IdempotencyKey = Type.String({ pattern: "^[A-Za-z0-9._:-]{8,200}$" });
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const MutationHeaders = Type.Object(
  { origin: Type.String({ minLength: 1 }), "x-csrf-token": Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
const Sport = Type.Union([
  Type.Literal("canoe_polo"),
  Type.Literal("badminton"),
  Type.Literal("table_tennis"),
  Type.Literal("volleyball"),
  Type.Literal("basketball"),
]);
const OrganisationBootstrapResponse = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1 }),
    role: Type.Union([Type.Literal("owner"), Type.Literal("organiser")]),
    created: Type.Boolean(),
  },
  { additionalProperties: false },
);

type SetupPatchRuntime = GateBPhase4Runtime & {
  resumeSetupDraft?: ReliableGateBPhase4Runtime["resumeSetupDraft"];
  ensureWritableOrganisation?: ReliableGateBPhase4Runtime["ensureWritableOrganisation"];
  gateCC4?: GateCC4Runtime;
  gateCC4Operations?: GateCC4Operations;
  gateCC4Lifecycle?: GateCC4LifecycleOperations;
};

function strict<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

function rejectUnknownBodyFields(allowed: readonly string[]) {
  const expected = new Set(allowed);
  return async (request: FastifyRequest) => {
    const body = request.body;
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).some((field) => !expected.has(field))
    )
      throw new ApiError(400, "REQUEST_INVALID", "Request body contains an unknown field");
  };
}

const Basics = strict({
  name: Type.String({ minLength: 1, maxLength: 160 }),
  sport_code: Sport,
  location: strict({
    venue: Type.String({ minLength: 1, maxLength: 240 }),
    address: Type.String({ minLength: 1, maxLength: 500 }),
    locality: Type.Union([Type.Null(), Type.String({ maxLength: 160 })]),
    country_code: Type.String({ pattern: "^[A-Z]{2}$" }),
  }),
  starts_on: Type.String({ format: "date" }),
  ends_on: Type.String({ format: "date" }),
  time_zone: Type.String({ minLength: 1, maxLength: 100 }),
  locale: Type.String({ minLength: 2, maxLength: 35 }),
  entry_count: Type.Integer({ minimum: 1, maximum: 10_000 }),
  division_count: Type.Integer({ minimum: 1, maximum: 1_000 }),
  entry_count_status: Type.Union([Type.Literal("confirmed"), Type.Literal("estimated")]),
});
const Preferences = strict({
  minimum_matches: strict({ per_entry: Type.Integer({ minimum: 1, maximum: 100 }) }),
  ranking: strict({ rank_all_entries: Type.Boolean() }),
  knockout: strict({ required: Type.Boolean() }),
  placement: strict({ required: Type.Boolean() }),
  qualification: strict({ cross_group_allowed: Type.Boolean() }),
  priority: strict({
    value: Type.Union([Type.Literal("speed"), Type.Literal("simplicity"), Type.Literal("participation")]),
  }),
});
const PatchBody = strict({
  expected_revision: Type.Integer({ minimum: 1 }),
  idempotency_key: IdempotencyKey,
  step: Type.Union([
    strict({ step_id: Type.Literal("basics"), value: Basics }),
    strict({ step_id: Type.Literal("format_preferences"), value: Preferences }),
  ]),
});
const ResumeBody = strict({ idempotency_key: IdempotencyKey });

export async function registerPhase4SetupPatchRoutes(
  app: FastifyInstance,
  options: {
    runtime: SetupPatchRuntime;
    identityRuntime: IdentityApiRuntime;
    identityRequests: IdentityRequestContext;
    allowedOrigins: readonly string[];
  },
) {
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

  if (options.runtime.ensureWritableOrganisation) {
    app.post(
      "/api/v1/organisations/competition-options/bootstrap",
      {
        schema: {
          security: [{ sessionCookie: [] }],
          headers: MutationHeaders,
          response: {
            200: OrganisationBootstrapResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
            503: ErrorResponse,
          },
          tags: ["phase3-competitions"],
        },
      },
      async (request) => options.runtime.ensureWritableOrganisation!(await mutationActor(request), request.id),
    );
  }

  app.patch<{
    Params: { competitionId: string };
    Body: Static<typeof PatchBody>;
  }>(
    "/api/v1/competitions/:competitionId/setup-draft",
    {
      preValidation: rejectUnknownBodyFields(["expected_revision", "idempotency_key", "step"]),
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id }),
        body: PatchBody,
        response: {
          200: Type.Unknown(),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          503: ErrorResponse,
        },
        tags: ["phase4-setup"],
      },
    },
    async (request) =>
      options.runtime.patchSetupDraft(
        await mutationActor(request),
        request.params.competitionId,
        request.body,
        request.id,
      ),
  );

  app.post<{
    Params: { competitionId: string };
    Body: Static<typeof ResumeBody>;
  }>(
    "/api/v1/competitions/:competitionId/setup-draft/resume",
    {
      preValidation: rejectUnknownBodyFields(["idempotency_key"]),
      schema: {
        security: [{ sessionCookie: [] }],
        headers: MutationHeaders,
        params: strict({ competitionId: Id }),
        body: ResumeBody,
        response: {
          200: Type.Unknown(),
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          422: ErrorResponse,
          503: ErrorResponse,
        },
        tags: ["phase4-setup"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      return options.runtime.resumeSetupDraft
        ? options.runtime.resumeSetupDraft(
            actor,
            request.params.competitionId,
            request.body.idempotency_key,
            request.id,
          )
        : options.runtime.readSetupDraft(actor, request.params.competitionId);
    },
  );

  if (options.runtime.gateCC4 && options.runtime.gateCC4Operations && options.runtime.gateCC4Lifecycle) {
    await registerGateCC4Routes(app, {
      runtime: options.runtime.gateCC4,
      operations: options.runtime.gateCC4Operations,
      lifecycle: options.runtime.gateCC4Lifecycle,
      identityRuntime: options.identityRuntime,
      identityRequests: options.identityRequests,
      allowedOrigins: options.allowedOrigins,
    });
  }
}
