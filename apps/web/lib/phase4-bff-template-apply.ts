import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPhase4IdempotencyKey, parseFormatDraft } from "@/lib/phase4-format";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ organisationId: string }> }) {
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, [
      "competition_id",
      "division_id",
      "template_version_id",
      "expected_format_revision",
      "idempotency_key",
    ]) ||
    typeof body.competition_id !== "string" ||
    typeof body.division_id !== "string" ||
    typeof body.template_version_id !== "string" ||
    !(
      body.expected_format_revision === null ||
      (Number.isSafeInteger(body.expected_format_revision) && (body.expected_format_revision as number) >= 1)
    ) ||
    !isPhase4IdempotencyKey(body.idempotency_key)
  )
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The template reuse command is invalid" } },
      { status: 400 },
    );
  const { organisationId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/organisations/${encodeURIComponent(organisationId)}/format-templates/apply`,
    body,
    validate: (value) => parseFormatDraft(value, body.competition_id as string, body.division_id as string) !== null,
  });
}
