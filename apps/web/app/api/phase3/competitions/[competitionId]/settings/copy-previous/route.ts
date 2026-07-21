import type { NextRequest } from "next/server";
import { forwardPhase3Mutation, isCopyResponse } from "@/lib/phase3-settings-command.server";
import { phase3CommandMachine } from "@/lib/phase3-sport-settings";

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3CommandMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/settings/copy-previous`,
    validate: isCopyResponse,
  });
}
