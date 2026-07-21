import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseAssistedSetupDocument } from "@/lib/phase4-assisted-setup";
import { isPhase4IdempotencyKey, parseOrganiserTemplate } from "@/lib/phase4-format";
import { competitionIdFromFormatReferer } from "@/lib/phase4-template-context";
import {
  forwardPhase3Mutation,
  hasExactKeys,
  jsonBody,
  readPhase3Json,
} from "@/lib/phase3-settings-command.server";

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

  const competitionId = competitionIdFromFormatReferer(request.headers.get("referer"), request.nextUrl.origin);
  if (!competitionId)
    return NextResponse.json(
      { error: { code: "COMPETITION_CONTEXT_REQUIRED", message: "The template command requires its competition context" } },
      { status: 400 },
    );

  const setupResult = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/setup-draft`,
  );
  if (!setupResult.ok)
    return NextResponse.json(
      {
        error: {
          code: setupResult.status === 401 || setupResult.status === 403 ? "AUTH_REQUIRED" : "SETUP_UNAVAILABLE",
          message:
            setupResult.status === 401 || setupResult.status === 403
              ? "An authenticated session is required"
              : "The competition setup could not be verified",
        },
      },
      { status: setupResult.status === 401 || setupResult.status === 403 ? setupResult.status : 503 },
    );

  const setup = parseAssistedSetupDocument(setupResult.payload, competitionId);
  const sportCode = setup?.values.basics?.sport_code;
  if (!setup || !sportCode)
    return NextResponse.json(
      { error: { code: "SPORT_NOT_PINNED", message: "Complete the competition basics before saving a format template" } },
      { status: 409 },
    );

  const { organisationId } = await params;
  if (setup.organisation_id !== organisationId)
    return NextResponse.json(
      { error: { code: "ORGANISATION_MISMATCH", message: "The competition does not belong to this organisation" } },
      { status: 403 },
    );

  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/organisations/${encodeURIComponent(organisationId)}/format-templates`,
    body: { ...body, sport_code: sportCode },
    validate: (value) => parseOrganiserTemplate(value, organisationId) !== null,
  });
}
