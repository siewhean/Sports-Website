import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPhase4IdempotencyKey, parseOrganiserTemplate } from "@/lib/phase4-format";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ organisationId: string; templateId: string }> },
) {
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, ["template_id", "expected_status", "idempotency_key"]) ||
    typeof body.template_id !== "string" ||
    body.expected_status !== "active" ||
    !isPhase4IdempotencyKey(body.idempotency_key)
  )
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The template archive command is invalid" } },
      { status: 400 },
    );
  const { organisationId, templateId } = await params;
  if (body.template_id !== templateId)
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Template identity mismatch" } },
      { status: 400 },
    );
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/organisations/${encodeURIComponent(organisationId)}/format-templates/${encodeURIComponent(templateId)}/archive`,
    body,
    validate: (value) => parseOrganiserTemplate(value, organisationId) !== null,
  });
}
