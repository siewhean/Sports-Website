import type { NextRequest } from "next/server";
import { forwardPhase3Mutation } from "@/lib/phase3-settings-command.server";
import { parseRecalculationResponse, phase3ResultsMachine } from "@/lib/phase3-results";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; divisionId: string }> },
) {
  const { competitionId, divisionId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3ResultsMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/standings/recalculate`,
    validate: (value) => parseRecalculationResponse(value, competitionId, divisionId) !== null,
  });
}
