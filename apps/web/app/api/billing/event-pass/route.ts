import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { messages } from "@matchday/ui";
import { parseEventPassCheckoutUrl } from "@/lib/event-pass-checkout";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";
import { requestPublicOrigin } from "@/lib/phase3-origin";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["organisationId", "competitionId"])) {
    return NextResponse.json(
      {
        error: {
          code: messages.eventPassCheckout.validationErrorCode,
          message: messages.eventPassCheckout.invalidRequest,
        },
      },
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
      {
        error: {
          code: messages.eventPassCheckout.validationErrorCode,
          message: messages.eventPassCheckout.invalidCompetition,
        },
      },
      { status: 400 },
    );
  }

  const publicOrigin = requestPublicOrigin(request.headers, process.env.MATCHDAY_PUBLIC_ORIGIN);
  if (!publicOrigin) {
    return NextResponse.json(
      {
        error: {
          code: messages.eventPassCheckout.publicOriginUnavailableCode,
          message: messages.eventPassCheckout.unavailableInEnvironment,
        },
      },
      { status: 503 },
    );
  }

  const target = { organisationId, competitionId };
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/organisations/${encodeURIComponent(organisationId)}/billing/checkout`,
    body: {
      tier: "event_pass",
      competitionId,
      successUrl: `${publicOrigin}/organiser/competitions?billing=event-pass-success`,
      cancelUrl: `${publicOrigin}/organiser/checkout/event-pass?billing=cancelled`,
    },
    validate: (value) => parseEventPassCheckoutUrl(value, target) !== null,
  });
}
