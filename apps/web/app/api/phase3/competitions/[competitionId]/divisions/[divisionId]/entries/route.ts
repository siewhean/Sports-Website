import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isEntryCreateBody, parseCreatedEntry, phase3EntriesCopy, phase3EntriesMachine } from "@/lib/phase3-entries";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; divisionId: string }> },
) {
  const body = await jsonBody(request);
  if (!isEntryCreateBody(body)) {
    return NextResponse.json(
      { error: { code: phase3EntriesMachine.entryCommandInvalid, message: phase3EntriesCopy.commandFailed } },
      { status: 400 },
    );
  }
  const { competitionId, divisionId } = await params;
  return forwardPhase3Mutation(request, {
    method: phase3EntriesMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/entries`,
    body,
    validate: (value) => parseCreatedEntry(value, divisionId) !== null,
  });
}
