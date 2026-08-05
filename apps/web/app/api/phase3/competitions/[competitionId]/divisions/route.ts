import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  isDivisionCreateBody,
  parseCreatedDivision,
  phase3EntriesCopy,
  phase3EntriesMachine,
} from "@/lib/phase3-entries";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (!isDivisionCreateBody(body)) {
    return NextResponse.json(
      { error: { code: phase3EntriesMachine.divisionCommandInvalid, message: phase3EntriesCopy.commandFailed } },
      { status: 400 },
    );
  }
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3EntriesMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/divisions`,
    body,
    validate: (value) => parseCreatedDivision(value, competitionId, body.entry_limit) !== null,
  });
}
