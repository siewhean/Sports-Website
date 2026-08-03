import type { NextRequest } from "next/server";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { isGateCC4RevisionResponse } from "@/lib/gate-c-c4-validators";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ competitionId: string; repairId: string }> },
) {
  const { competitionId, repairId } = await context.params;
  const body = await jsonBody(request);
  if (!body)
    return Response.json({ error: { code: gateCC4Http.errors.requestInvalid } }, { status: 400 });
  return forwardPhase3Mutation(request, {
    method: gateCC4Http.methodPost,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(repairId)}/revisions`,
    body,
    validate: isGateCC4RevisionResponse,
    successStatus: 201,
  });
}
