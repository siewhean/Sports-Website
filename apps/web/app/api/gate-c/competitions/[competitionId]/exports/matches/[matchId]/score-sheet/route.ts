import type { NextRequest } from "next/server";
import { forwardGateCC4BinaryMutation } from "@/lib/gate-c-c4-command.server";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ competitionId: string; matchId: string }> },
) {
  const { competitionId, matchId } = await context.params;
  const path = `/api/v1/competitions/${encodeURIComponent(competitionId)}/exports/matches/${encodeURIComponent(matchId)}/score-sheet`;
  return forwardGateCC4BinaryMutation(request, path);
}
