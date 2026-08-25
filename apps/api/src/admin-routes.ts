import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, ErrorCode } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { AdminRuntime } from "./admin-runtime.js";

const Id = Type.String({ format: "uuid" });
const Json = Type.Unknown();
const ErrorResponse = Type.Object(
  { error: Type.Object({ code: Type.String(), message: Type.String(), request_id: Type.String() }) },
  { additionalProperties: false },
);
const MutationResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
  503: ErrorResponse,
};
const ReadResponses = { 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse };

export async function registerAdminRoutes(
  app: FastifyInstance,
  options: {
    runtime: AdminRuntime;
    identityRequests: IdentityRequestContext;
  },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await options.identityRequests.authenticate(request);
    return {
      accountId: session.account.id,
    };
  };

  const mutationActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await options.identityRequests.authenticate(request);
    const csrfHeader = request.headers["x-csrf-token"];
    if (!csrfHeader || csrfHeader !== session.csrfToken) {
      throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
    }
    return {
      accountId: session.account.id,
    };
  };

  // List organisations
  app.get(
    "/api/v1/admin/organisations",
    {
      schema: {
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.listOrganisations(actor);
    },
  );

  // Get organisation details
  app.get<{ Params: { organisationId: string } }>(
    "/api/v1/admin/organisations/:organisationId",
    {
      schema: {
        params: Type.Object({ organisationId: Id }),
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.getOrganisationDetails(actor, request.params.organisationId);
    },
  );

  // Update organisation entitlements
  app.post<{
    Params: { organisationId: string };
    Body: { tier?: "free" | "event_pass" | "organiser_pro"; top_up_ai_units?: number; reason?: string };
  }>(
    "/api/v1/admin/organisations/:organisationId/entitlements",
    {
      schema: {
        params: Type.Object({ organisationId: Id }),
        body: Type.Object({
          tier: Type.Optional(
            Type.Union([Type.Literal("free"), Type.Literal("event_pass"), Type.Literal("organiser_pro")]),
          ),
          top_up_ai_units: Type.Optional(Type.Integer({ minimum: 1 })),
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      return options.runtime.updateEntitlements(actor, request.params.organisationId, request.body, request.id);
    },
  );

  // AI accounting summary
  app.get(
    "/api/v1/admin/ai/usage-summary",
    {
      schema: {
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.getAiAccountingSummary(actor);
    },
  );

  // Audit trail explorer
  app.get<{
    Querystring: { organisation_id?: string; action?: string; limit?: number };
  }>(
    "/api/v1/admin/audit-events",
    {
      schema: {
        querystring: Type.Object({
          organisation_id: Type.Optional(Id),
          action: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.getAuditEvents(actor, {
        organisationId: request.query.organisation_id,
        action: request.query.action,
        limit: request.query.limit,
      });
    },
  );
}
