import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseV1FormatApplication, parseV1FormatRecommendations } from "./phase4-v1-format-picker";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "./phase3-settings-command.server";

function invalid() {
  return NextResponse.json(
    { error: { code: "VALIDATION_ERROR", message: "The format recommendation command is invalid" } },
    { status: 400 },
  );
}

function validBody(value: Record<string, unknown> | null): value is { idempotency_key: string } {
  return Boolean(
    value &&
    hasExactKeys(value, ["idempotency_key"]) &&
    typeof value.idempotency_key === "string" &&
    /^[A-Za-z0-9._:-]{8,180}$/.test(value.idempotency_key),
  );
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (!validBody(body)) return invalid();
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/v1-format-recommendations`,
    body,
    validate: (value) => parseV1FormatRecommendations(value, competitionId) !== null,
  });
}

export async function applyV1FormatRecommendation(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; recommendationId: string }> },
) {
  const body = await jsonBody(request);
  if (!validBody(body)) return invalid();
  const { competitionId, recommendationId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/v1-format-recommendations/${encodeURIComponent(recommendationId)}/apply`,
    body,
    validate: (value) => parseV1FormatApplication(value, competitionId) !== null,
  });
}
