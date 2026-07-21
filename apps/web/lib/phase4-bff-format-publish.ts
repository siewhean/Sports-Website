import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPhase4IdempotencyKey } from "@/lib/phase4-format";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

function isResponse(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ formatId: string }> }) {
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, ["idempotency_key"]) || !isPhase4IdempotencyKey(body.idempotency_key))
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The publication command is invalid" } },
      { status: 400 },
    );
  const { formatId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/format-revisions/${encodeURIComponent(formatId)}/publish`,
    body,
    validate: isResponse,
  });
}
