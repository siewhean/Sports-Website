import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPhase4SetupIdempotencyKey, parseAssistedSetupDocument } from "@/lib/phase4-assisted-setup";
import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import { demoAssistedSetupDocument } from "@/lib/phase4-assisted-setup.server";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

function invalid() {
  return NextResponse.json(
    { error: { code: "VALIDATION_ERROR", message: "The setup resume command is invalid" } },
    { status: 400 },
  );
}

function demoPreviewStep(request: NextRequest): string | undefined {
  const referrer = request.headers.get("referer");
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    const requestOrigin = request.headers.get("origin");
    return requestOrigin && url.origin === requestOrigin ? (url.searchParams.get("step") ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["idempotency_key"]) || !isPhase4SetupIdempotencyKey(body.idempotency_key))
    return invalid();
  const { competitionId } = await params;
  if (demoFixturesEnabled())
    return NextResponse.json(demoAssistedSetupDocument(competitionId, demoPreviewStep(request)));
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/setup-draft/resume`,
    body,
    validate: (value) => parseAssistedSetupDocument(value, competitionId) !== null,
  });
}
