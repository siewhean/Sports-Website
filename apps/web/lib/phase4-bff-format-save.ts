import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isSaveFormatRequest, parseFormatDraft } from "@/lib/phase4-format";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; divisionId: string }> },
) {
  const body = await jsonBody(request);
  if (!isSaveFormatRequest(body))
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The format draft command is invalid" } },
      { status: 400 },
    );
  const { competitionId, divisionId } = await params;
  return forwardPhase3Mutation(request, {
    method: "PUT",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/format-builder`,
    body,
    validate: (value) => parseFormatDraft(value, competitionId, divisionId) !== null,
  });
}
