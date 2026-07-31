import type { NextRequest } from "next/server";
import { jsonBody, forwardPhase3Mutation } from "@/lib/phase3-settings-command.server";
import { isGateCC4RevisionResponse } from "@/lib/gate-c-c4-validators";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ competitionId: string; repairId: string }> },
) {
  const { competitionId, repairId } = await context.params;
  const body = await jsonBody(request);
  if (!body) return Response.json({ error: { code: "REQUEST_INVALID" } }, { status: 400 });
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(repairId)}/revisions`,
    body,
    validate: isGateCC4RevisionResponse,
    successStatus: 201,
  });
}
