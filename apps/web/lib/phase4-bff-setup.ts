import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  isAssistedSetupAutosaveRequest,
  isPhase4SetupIdempotencyKey,
  parseAssistedSetupAutosaveResponse,
  parseAssistedSetupDocument,
} from "@/lib/phase4-assisted-setup";
import { isAssistedSetupPatchRequest } from "@/lib/phase4-assisted-setup-patch";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

function invalid() {
  return NextResponse.json(
    { error: { code: "VALIDATION_ERROR", message: "The setup command is invalid" } },
    { status: 400 },
  );
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["idempotency_key"]) || !isPhase4SetupIdempotencyKey(body.idempotency_key))
    return invalid();
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/setup-draft`,
    body,
    validate: (value) => parseAssistedSetupDocument(value, competitionId) !== null,
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (!isAssistedSetupAutosaveRequest(body)) return invalid();
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: "PUT",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/setup-draft`,
    body,
    validate: (value) => parseAssistedSetupAutosaveResponse(value, competitionId) !== null,
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (!isAssistedSetupPatchRequest(body)) return invalid();
  const { competitionId } = await params;
  return forwardPhase3Mutation(request, {
    method: "PATCH",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/setup-draft`,
    body,
    validate: (value) => parseAssistedSetupAutosaveResponse(value, competitionId) !== null,
  });
}
