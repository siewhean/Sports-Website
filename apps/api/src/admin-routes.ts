import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { AdminRuntime } from "./admin-runtime.js";
import { requireMutationSession } from "./mutation-guard.js";

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
    allowedOrigins: readonly string[];
  },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await options.identityRequests.authenticate(request);
    return {
      accountId: session.account.id,
    };
  };

  const mutationActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await requireMutationSession(request, options.identityRequests, options.allowedOrigins);
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

  // Update organisation entitlements (fixed payload mapping for top_up_ai_units)
  app.post<{
    Params: { organisationId: string };
    Body: {
      tier?: "free" | "event_pass" | "organiser_pro";
      competition_id?: string;
      top_up_ai_units?: number;
      reason?: string;
    };
  }>(
    "/api/v1/admin/organisations/:organisationId/entitlements",
    {
      schema: {
        params: Type.Object({ organisationId: Id }),
        body: Type.Object({
          tier: Type.Optional(
            Type.Union([Type.Literal("free"), Type.Literal("event_pass"), Type.Literal("organiser_pro")]),
          ),
          competition_id: Type.Optional(Id),
          top_up_ai_units: Type.Optional(Type.Integer({ minimum: 1 })),
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      const input: {
        tier?: "free" | "event_pass" | "organiser_pro";
        competitionId?: string;
        topUpAiUnits?: number;
        reason?: string;
      } = {};
      if (request.body.tier !== undefined) input.tier = request.body.tier;
      if (request.body.competition_id !== undefined) input.competitionId = request.body.competition_id;
      if (request.body.top_up_ai_units !== undefined) input.topUpAiUnits = request.body.top_up_ai_units;
      if (request.body.reason !== undefined) input.reason = request.body.reason;
      return options.runtime.updateEntitlements(actor, request.params.organisationId, input, request.id);
    },
  );

  // Revoke scoring access pass
  app.post<{
    Params: { passId: string };
    Body: { reason?: string };
  }>(
    "/api/v1/admin/access-passes/:passId/revoke",
    {
      schema: {
        params: Type.Object({ passId: Id }),
        body: Type.Object({
          reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      return options.runtime.revokeAccessPass(actor, request.params.passId, request.body.reason);
    },
  );

  // Reset scoring access pass expiration
  app.post<{
    Params: { passId: string };
  }>(
    "/api/v1/admin/access-passes/:passId/reset",
    {
      schema: {
        params: Type.Object({ passId: Id }),
        response: { 200: Json, ...MutationResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      return options.runtime.resetAccessPass(actor, request.params.passId);
    },
  );

  // Get sport default configuration
  app.get<{
    Params: { sportCode: string };
  }>(
    "/api/v1/admin/sports/:sportCode/defaults",
    {
      schema: {
        params: Type.Object({ sportCode: Type.String({ minLength: 1 }) }),
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.getSportDefaults(actor, request.params.sportCode);
    },
  );

  // Update sport default configuration
  app.put<{
    Params: { sportCode: string };
    Body: { definition: Record<string, unknown> };
  }>(
    "/api/v1/admin/sports/:sportCode/defaults",
    {
      schema: {
        params: Type.Object({ sportCode: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          definition: Type.Record(Type.String(), Json),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      return options.runtime.updateSportDefaults(actor, request.params.sportCode, request.body.definition);
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

  // --- OPS-018: Feature Flag Admin Endpoints ---

  const FeatureFlagScopeSchema = Type.Union([
    Type.Object({ kind: Type.Literal("global") }),
    Type.Object({ kind: Type.Literal("organization"), id: Id }),
    Type.Object({ kind: Type.Literal("competition"), id: Id }),
    Type.Object({ kind: Type.Literal("account"), id: Id }),
  ]);

  // List all feature flags and active overrides
  app.get(
    "/api/v1/admin/feature-flags",
    {
      schema: {
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.listFeatureFlags(actor);
    },
  );

  // Get specific feature flag and its overrides
  app.get<{
    Params: { key: string };
  }>(
    "/api/v1/admin/feature-flags/:key",
    {
      schema: {
        params: Type.Object({ key: Type.String({ minLength: 1 }) }),
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.getFeatureFlag(actor, request.params.key);
    },
  );

  // Evaluate effective feature flag value for given context
  app.get<{
    Params: { key: string };
    Querystring: {
      organization_id?: string;
      competition_id?: string;
      account_id?: string;
    };
  }>(
    "/api/v1/admin/feature-flags/:key/effective",
    {
      schema: {
        params: Type.Object({ key: Type.String({ minLength: 1 }) }),
        querystring: Type.Object({
          organization_id: Type.Optional(Id),
          competition_id: Type.Optional(Id),
          account_id: Type.Optional(Id),
        }),
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.getEffectiveFeatureFlag(actor, request.params.key, {
        ...(request.query.organization_id ? { organizationId: request.query.organization_id } : {}),
        ...(request.query.competition_id ? { competitionId: request.query.competition_id } : {}),
        ...(request.query.account_id ? { accountId: request.query.account_id } : {}),
      });
    },
  );

  // Get audit events for a feature flag
  app.get<{
    Params: { key: string };
    Querystring: { limit?: number };
  }>(
    "/api/v1/admin/feature-flags/:key/audit",
    {
      schema: {
        params: Type.Object({ key: Type.String({ minLength: 1 }) }),
        querystring: Type.Object({
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
        response: { 200: Json, ...ReadResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await readActor(request);
      return options.runtime.getFeatureFlagAudit(actor, request.params.key, request.query.limit);
    },
  );

  // Set or update feature flag override
  app.put<{
    Params: { key: string };
    Body: {
      scope: {
        kind: "global" | "organization" | "competition" | "account";
        id?: string;
      };
      value: boolean;
      reason: string;
      expected_updated_at?: string;
    };
  }>(
    "/api/v1/admin/feature-flags/:key/override",
    {
      schema: {
        params: Type.Object({ key: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          scope: FeatureFlagScopeSchema,
          value: Type.Boolean(),
          reason: Type.String({ minLength: 3 }),
          expected_updated_at: Type.Optional(Type.String()),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      const requestId = request.id;
      return options.runtime.setFeatureFlagOverride(actor, request.params.key, request.body as never, requestId);
    },
  );

  // Delete feature flag override
  app.delete<{
    Params: { key: string };
    Body: {
      scope: {
        kind: "global" | "organization" | "competition" | "account";
        id?: string;
      };
      reason: string;
      expected_updated_at?: string;
    };
  }>(
    "/api/v1/admin/feature-flags/:key/override",
    {
      schema: {
        params: Type.Object({ key: Type.String({ minLength: 1 }) }),
        body: Type.Object({
          scope: FeatureFlagScopeSchema,
          reason: Type.String({ minLength: 3 }),
          expected_updated_at: Type.Optional(Type.String()),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["admin"],
      },
    },
    async (request) => {
      const actor = await mutationActor(request);
      const requestId = request.id;
      return options.runtime.deleteFeatureFlagOverride(actor, request.params.key, request.body as never, requestId);
    },
  );
}
