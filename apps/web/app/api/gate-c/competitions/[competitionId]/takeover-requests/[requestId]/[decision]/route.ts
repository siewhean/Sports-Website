import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCAccessMachine, parseTakeoverDecision } from "@/lib/gate-c-access";
import { phase2Copy } from "@/lib/phase2";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ competitionId: string; requestId: string; decision: string }>;
  },
) {
  const { competitionId, requestId, decision } = await params;
  if (decision !== gateCAccessMachine.approve && decision !== gateCAccessMachine.deny) {
    return NextResponse.json(
      { error: { code: gateCAccessMachine.takeoverDecisionInvalid, message: phase2Copy.serviceUnavailable } },
      { status: 404 },
    );
  }
  const body = await jsonBody(request);
  const reason = body && typeof body.reason === "string" ? body.reason.trim() : "";
  const acknowledged = body?.overrideAcknowledged === true;
  if (reason.length < 3 || reason.length > 500) {
    return NextResponse.json(
      { error: { code: gateCAccessMachine.takeoverReasonInvalid, message: phase2Copy.serviceUnavailable } },
      { status: 400 },
    );
  }
  return forwardPhase3Mutation(request, {
    method: gateCAccessMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/takeover-requests/${encodeURIComponent(requestId)}/${decision}`,
    body: { reason, override_acknowledged: acknowledged },
    validate: (value) => parseTakeoverDecision(value) !== null,
  });
}
