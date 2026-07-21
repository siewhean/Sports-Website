import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPhase4IdempotencyKey, parseFormatMaterialisation } from "@/lib/phase4-format";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

export async function POST(request: NextRequest, { params }: { params: Promise<{ formatId: string }> }) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["idempotency_key"]) || !isPhase4IdempotencyKey(body.idempotency_key))
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The materialisation command is invalid" } },
      { status: 400 },
    );
  const { formatId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/format-revisions/${encodeURIComponent(formatId)}/materialise`,
    body,
    validate: (value) => parseFormatMaterialisation(value, formatId) !== null,
  });
}
