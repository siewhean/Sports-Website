import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isPhase4IdempotencyKey } from "@/lib/phase4-format";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRequest(value: Record<string, unknown> | null): value is Record<string, unknown> {
  if (!value) return false;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "competition_id,idempotency_key,locale,text" && keys !== "competition_id,idempotency_key,text" && keys !== "idempotency_key,locale,text" && keys !== "idempotency_key,text") return false;
  return (
    isPhase4IdempotencyKey(value.idempotency_key) &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    value.text.length <= 10_000 &&
    (value.locale === undefined || typeof value.locale === "string") &&
    (value.competition_id === undefined || typeof value.competition_id === "string")
  );
}

function isResponse(value: unknown): boolean {
  const item = record(value);
  if (!item || typeof item.status !== "string" || typeof item.charged_units !== "number") return false;
  if (item.status === "success")
    return record(item.brief) !== null && Array.isArray(item.missing_fields) && record(item.usage) !== null;
  return (
    (item.status === "manual_fallback" || item.status === "quota_exhausted") &&
    typeof item.preserved_text === "string" &&
    item.charged_units === 0 &&
    record(item.usage) !== null
  );
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ organisationId: string }> }) {
  const body = await jsonBody(request);
  if (!isRequest(body))
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "The competition brief request is invalid" } },
      { status: 400 },
    );
  const { organisationId } = await params;
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/organisations/${encodeURIComponent(organisationId)}/ai/competition-brief`,
    body,
    validate: isResponse,
  });
}
