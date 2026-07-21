import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPhase4IdempotencyKey, parseOrganiserTemplate } from "@/lib/phase4-format";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ organisationId: string }> }) {
  const body = await jsonBody(request);
  const keys = [
    "template_id",
    "parent_version_id",
    "expected_version",
    "name",
    "description",
    "sport_code",
    "source_format_revision_id",
    "idempotency_key",
  ];
  if (
    !body ||
    !hasExactKeys(body, keys) ||
    !(body.template_id === null || typeof body.template_id === "string") ||
    !(body.parent_version_id === null || typeof body.parent_version_id === "string") ||
    !(body.expected_version === null || (Number.isSafeInteger(body.expected_version) && (body.expected_version as number) >= 1)) ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 120 ||
    !(body.description === null || typeof body.description === "string") ||
    typeof body.sport_code !== "string" ||
    typeof body.source_format_revision_id !== "string" ||
    !isPhase4IdempotencyKey(body.idempotency_key)
  )
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The organiser template command is invalid" } },
      { status: 400 },
    );
  const { organisationId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/organisations/${encodeURIComponent(organisationId)}/format-templates`,
    body,
    validate: (value) => parseOrganiserTemplate(value, organisationId) !== null,
  });
}
