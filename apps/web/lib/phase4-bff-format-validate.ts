import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseFormatBuilderDocument, parseFormatValidation } from "@/lib/phase4-format";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; divisionId: string }> },
) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["document"]) || !parseFormatBuilderDocument(body.document))
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The format validation request is invalid" } },
      { status: 400 },
    );
  const { competitionId, divisionId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/divisions/${encodeURIComponent(divisionId)}/format-builder/validate`,
    body,
    validate: (value) => parseFormatValidation(value) !== null,
  });
}
