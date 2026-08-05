import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCAccessMachine, parseRotatedFallback } from "@/lib/gate-c-access";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { translate as t } from "@matchday/ui";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; passId: string }> },
) {
  const body = await jsonBody(request);
  if (!body || typeof body.idempotencyKey !== "string" || !UUID_PATTERN.test(body.idempotencyKey)) {
    return NextResponse.json(
      { error: { code: gateCAccessMachine.errorCode, message: t("prototype.e31ce022f3b8") } },
      { status: 400 },
    );
  }
  const { competitionId, passId } = await params;
  return forwardPhase3Mutation(request, {
    method: gateCAccessMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/access-passes/${encodeURIComponent(passId)}/fallback-code/rotate`,
    body: { idempotency_key: body.idempotencyKey },
    validate: (value) => parseRotatedFallback(value) !== null,
  });
}
