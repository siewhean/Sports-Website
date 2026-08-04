import type { NextRequest } from "next/server";
import { gateCC4BffMachine } from "@/lib/gate-c-c4-bff";
import { jsonBody, forwardPhase3Mutation } from "@/lib/phase3-settings-command.server";
import { isGateCC4PublicationReceipt } from "@/lib/gate-c-c4-validators";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ competitionId: string; repairId: string; revisionId: string }> },
) {
  const { competitionId, repairId, revisionId } = await context.params;
  const body = await jsonBody(request);
  if (!body) return Response.json({ error: { code: gateCC4BffMachine.errors.requestInvalid } }, { status: 400 });
  return forwardPhase3Mutation(request, {
    method: gateCC4BffMachine.methods.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/${encodeURIComponent(repairId)}/revisions/${encodeURIComponent(revisionId)}/publish`,
    body,
    validate: isGateCC4PublicationReceipt,
  });
}
