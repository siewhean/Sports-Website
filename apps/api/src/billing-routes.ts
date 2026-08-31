import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BillingWebhookPayload } from "@matchday/contracts";
import { ApiError, ErrorCode } from "./errors.js";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { EntitlementRuntime } from "./entitlement-runtime.js";

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

export async function registerBillingRoutes(
  app: FastifyInstance,
  options: { runtime: EntitlementRuntime; identityRequests: IdentityRequestContext },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await options.identityRequests.authenticate(request);
    return { accountId: session.account.id };
  };
  const mutationActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await options.identityRequests.authenticate(request);
    const csrfHeader = request.headers["x-csrf-token"];
    if (!csrfHeader || csrfHeader !== session.csrfToken)
      throw new ApiError(403, ErrorCode.CSRF_INVALID, "CSRF validation failed");
    return { accountId: session.account.id };
  };

  app.post(
    "/api/v1/billing/webhook",
    {
      schema: {
        body: Type.Object({
          id: Type.String(),
          type: Type.String(),
          data: Type.Object({
            object: Type.Object(
              {
                id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                customer: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                subscription: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                client_reference_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                amount_total: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                currency: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                status: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                current_period_start: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                current_period_end: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                metadata: Type.Optional(
                  Type.Union([
                    Type.Object(
                      {
                        organisation_id: Type.Optional(Type.String()),
                        competition_id: Type.Optional(Type.String()),
                        tier: Type.Optional(Type.String()),
                        purchase_type: Type.Optional(Type.String()),
                        top_up_units: Type.Optional(Type.String()),
                      },
                      { additionalProperties: true },
                    ),
                    Type.Null(),
                  ]),
                ),
              },
              { additionalProperties: true },
            ),
          }),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["billing"],
      },
    },
    async (request) => {
      const signature = request.headers["stripe-signature"] as string | undefined;
      const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
      return options.runtime.processBillingWebhook(signature, rawBody, request.body as BillingWebhookPayload);
    },
  );

  app.get<{ Params: { organisationId: string } }>(
    "/api/v1/organisations/:organisationId/billing/current",
    {
      schema: {
        params: Type.Object({ organisationId: Id }),
        response: { 200: Json, ...ReadResponses },
        tags: ["billing"],
      },
    },
    async (request) =>
      options.runtime.getBillingSummaryForActor(await readActor(request), request.params.organisationId),
  );

  app.get<{ Params: { organisationId: string } }>(
    "/api/v1/organisations/:organisationId/billing/history",
    {
      schema: {
        params: Type.Object({ organisationId: Id }),
        response: { 200: Json, ...ReadResponses },
        tags: ["billing"],
      },
    },
    async (request) => options.runtime.getBillingHistory(await readActor(request), request.params.organisationId),
  );

  type CheckoutBody =
    | { tier: "event_pass"; competitionId: string; topUpUnits?: number; successUrl: string; cancelUrl: string }
    | { tier: "organiser_pro"; topUpUnits?: number; successUrl: string; cancelUrl: string }
    | { purchaseType: "ai_top_up"; topUpUnits: number; successUrl: string; cancelUrl: string };
  app.post<{ Params: { organisationId: string }; Body: CheckoutBody }>(
    "/api/v1/organisations/:organisationId/billing/checkout",
    {
      schema: {
        params: Type.Object({ organisationId: Id }),
        body: Type.Union([
          Type.Object({
            tier: Type.Literal("event_pass"),
            competitionId: Id,
            topUpUnits: Type.Optional(Type.Integer({ minimum: 1 })),
            successUrl: Type.String({ minLength: 1 }),
            cancelUrl: Type.String({ minLength: 1 }),
          }),
          Type.Object({
            tier: Type.Literal("organiser_pro"),
            topUpUnits: Type.Optional(Type.Integer({ minimum: 1 })),
            successUrl: Type.String({ minLength: 1 }),
            cancelUrl: Type.String({ minLength: 1 }),
          }),
          Type.Object({
            purchaseType: Type.Literal("ai_top_up"),
            topUpUnits: Type.Integer({ minimum: 1 }),
            successUrl: Type.String({ minLength: 1 }),
            cancelUrl: Type.String({ minLength: 1 }),
          }),
        ]),
        response: { 200: Json, ...MutationResponses },
        tags: ["billing"],
      },
    },
    async (request) =>
      options.runtime.createCheckoutSession(await mutationActor(request), request.params.organisationId, request.body),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/branding",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        response: { 200: Json, ...ReadResponses },
        tags: ["branding"],
      },
    },
    async (request) => options.runtime.getBranding(request.params.competitionId),
  );

  app.put<{
    Params: { organisationId: string; competitionId: string };
    Body: {
      primary_color?: string;
      secondary_color?: string;
      logo_url?: string | null;
      banner_url?: string | null;
      hide_platform_badge?: boolean;
    };
  }>(
    "/api/v1/organisations/:organisationId/competitions/:competitionId/branding",
    {
      schema: {
        params: Type.Object({ organisationId: Id, competitionId: Id }),
        body: Type.Object({
          primary_color: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
          secondary_color: Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" })),
          logo_url: Type.Optional(Type.Union([Type.String({ format: "uri" }), Type.Null()])),
          banner_url: Type.Optional(Type.Union([Type.String({ format: "uri" }), Type.Null()])),
          hide_platform_badge: Type.Optional(Type.Boolean()),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["branding"],
      },
    },
    async (request) =>
      options.runtime.setBranding(
        await mutationActor(request),
        request.params.organisationId,
        request.params.competitionId,
        request.body,
      ),
  );

  app.get<{ Params: { competitionId: string } }>(
    "/api/v1/competitions/:competitionId/sponsors",
    {
      schema: {
        params: Type.Object({ competitionId: Id }),
        response: { 200: Json, ...ReadResponses },
        tags: ["sponsors"],
      },
    },
    async (request) => options.runtime.getSponsors(request.params.competitionId),
  );

  app.put<{
    Params: { organisationId: string; competitionId: string };
    Body: {
      sponsors: Array<{
        name: string;
        tier: "headline" | "tier1" | "tier2" | "community";
        logo_url?: string;
        website_url?: string;
        sort_order: number;
      }>;
    };
  }>(
    "/api/v1/organisations/:organisationId/competitions/:competitionId/sponsors",
    {
      schema: {
        params: Type.Object({ organisationId: Id, competitionId: Id }),
        body: Type.Object({
          sponsors: Type.Array(
            Type.Object({
              name: Type.String({ minLength: 1, maxLength: 100 }),
              tier: Type.Union([
                Type.Literal("headline"),
                Type.Literal("tier1"),
                Type.Literal("tier2"),
                Type.Literal("community"),
              ]),
              logo_url: Type.Optional(Type.String({ format: "uri" })),
              website_url: Type.Optional(Type.String({ format: "uri" })),
              sort_order: Type.Integer({ minimum: 0 }),
            }),
          ),
        }),
        response: { 200: Json, ...MutationResponses },
        tags: ["sponsors"],
      },
    },
    async (request) =>
      options.runtime.setSponsors(
        await mutationActor(request),
        request.params.organisationId,
        request.params.competitionId,
        request.body.sponsors,
      ),
  );
}
