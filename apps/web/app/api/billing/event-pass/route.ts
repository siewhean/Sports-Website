import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";
import { requestPublicOrigin } from "@/lib/phase3-origin";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isEventPassCheckoutResponse(value: unknown, organisationId: string, competitionId: string): boolean {
  if (!isRecord(value)) return false;
  if (
    value.organisation_id !== organisationId ||
    value.competition_id !== competitionId ||
    value.tier !== "event_pass" ||
    value.purchase_type !== "plan" ||
    typeof value.checkout_url !== "string"
  ) {
    return false;
  }
  try {
    const checkout = new URL(value.checkout_url);
    return checkout.protocol === "https:" && checkout.hostname === "checkout.stripe.com";
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["organisationId", "competitionId"])) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Select one competition for the Event Pass" } },
      { status: 400 },
    );
  }
  const { organisationId, competitionId } = body;
  if (
    typeof organisationId !== "string" ||
    typeof competitionId !== "string" ||
    !uuidPattern.test(organisationId) ||
    !uuidPattern.test(competitionId)
  ) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Select a valid competition for the Event Pass" } },
      { status: 400 },
    );
  }

  const publicOrigin = requestPublicOrigin(request.headers, process.env.MATCHDAY_PUBLIC_ORIGIN);
  if (!publicOrigin) {
    return NextResponse.json(
      { error: { code: "PUBLIC_ORIGIN_UNAVAILABLE", message: "Checkout is unavailable in this environment" } },
      { status: 503 },
    );
  }

  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/organisations/${encodeURIComponent(organisationId)}/billing/checkout`,
    body: {
      tier: "event_pass",
      competitionId,
      successUrl: `${publicOrigin}/organiser/competitions?billing=event-pass-success`,
      cancelUrl: `${publicOrigin}/organiser/checkout/event-pass?billing=cancelled`,
    },
    validate: (value) => isEventPassCheckoutResponse(value, organisationId, competitionId),
  });
}
