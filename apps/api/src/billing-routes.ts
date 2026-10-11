import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IdentityRequestContext } from "./identity-routes.js";
import type { Phase3Actor } from "./phase-3-runtime.js";
import type { EntitlementRuntime, StripeWebhookEvent } from "./entitlement-runtime.js";
import { requireMutationSession } from "./mutation-guard.js";
import { MAX_CHECKOUT_TOP_UP_UNITS } from "./stripe-checkout-client.js";

const Id = Type.String({ format: "uuid" });
// Origin/scheme are enforced in EntitlementRuntime against the configured MATCHDAY origins.
const RedirectUrl = Type.String({ format: "uri", minLength: 1, maxLength: 2_048 });
// Branding/sponsor links are rendered on public pages: https only (no javascript:/data: schemes).
export const HttpsUrl = Type.String({ format: "uri", pattern: "^https://[^\\s]+$", maxLength: 2_048 });
const TopUpUnits = Type.Integer({ minimum: 1, maximum: MAX_CHECKOUT_TOP_UP_UNITS });
const NullableString = Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()]));
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
  options: { runtime: EntitlementRuntime; identityRequests: IdentityRequestContext; allowedOrigins: readonly string[] },
) {
  const readActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await options.identityRequests.authenticate(request);
    return { accountId: session.account.id };
  };
  const mutationActor = async (request: FastifyRequest): Promise<Phase3Actor> => {
    const session = await requireMutationSession(request, options.identityRequests, options.allowedOrigins);
    return { accountId: session.account.id };
  };

  app.post(
    "/api/v1/billing/webhook",
    {
      schema: {
        // Signature verification runs over the raw body captured in app.ts, so closing these objects
        // (Fastify strips unknown properties) only drops PII such as customer_details from the parsed
        // copy; EntitlementRuntime additionally stores an allow-listed projection.
        body: Type.Object({
          id: Type.String({ minLength: 1, maxLength: 255 }),
          type: Type.String({ minLength: 1, maxLength: 128 }),
          created: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
          data: Type.Object({
            object: Type.Object(
              {
                id: NullableString,
                mode: NullableString,
                payment_status: NullableString,
                customer: NullableString,
                subscription: NullableString,
                client_reference_id: NullableString,
                amount_total: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                currency: NullableString,
                status: NullableString,
                current_period_start: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                current_period_end: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
                metadata: Type.Optional(
                  Type.Union([
                    Type.Object(
                      {
                        organisation_id: Type.Optional(Type.String({ maxLength: 64 })),
                        competition_id: Type.Optional(Type.String({ maxLength: 64 })),
                        tier: Type.Optional(Type.String({ maxLength: 32 })),
                        purchase_type: Type.Optional(Type.String({ maxLength: 32 })),
                        top_up_units: Type.Optional(Type.String({ maxLength: 16 })),
                      },
                      { additionalProperties: false },
                    ),
                    Type.Null(),
                  ]),
                ),
              },
              { additionalProperties: false },
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
      return options.runtime.processBillingWebhook(signature, rawBody, request.body as StripeWebhookEvent);
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
            topUpUnits: Type.Optional(TopUpUnits),
            successUrl: RedirectUrl,
            cancelUrl: RedirectUrl,
          }),
          Type.Object({
            tier: Type.Literal("organiser_pro"),
            topUpUnits: Type.Optional(TopUpUnits),
            successUrl: RedirectUrl,
            cancelUrl: RedirectUrl,
          }),
          Type.Object({
            purchaseType: Type.Literal("ai_top_up"),
            topUpUnits: TopUpUnits,
            successUrl: RedirectUrl,
            cancelUrl: RedirectUrl,
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
          logo_url: Type.Optional(Type.Union([HttpsUrl, Type.Null()])),
          banner_url: Type.Optional(Type.Union([HttpsUrl, Type.Null()])),
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
              logo_url: Type.Optional(HttpsUrl),
              website_url: Type.Optional(HttpsUrl),
              sort_order: Type.Integer({ minimum: 0, maximum: 32_767 }),
            }),
            { maxItems: 50 },
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
