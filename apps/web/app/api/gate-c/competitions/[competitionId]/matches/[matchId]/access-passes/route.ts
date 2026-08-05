import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCAccessMachine, parseIssuedAccessPass } from "@/lib/gate-c-access";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import { translate as t } from "@matchday/ui";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; matchId: string }> },
) {
  const body = await jsonBody(request);
  if (
    !body ||
    (body.role !== "viewer" && body.role !== "scorekeeper") ||
    typeof body.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(body.expiresAt)) ||
    typeof body.idempotencyKey !== "string" ||
    !UUID_PATTERN.test(body.idempotencyKey)
  ) {
    return NextResponse.json(
      { error: { code: gateCAccessMachine.errorCode, message: t("prototype.4f6eaf0372b7") } },
      { status: 400 },
    );
  }
  const { competitionId, matchId } = await params;
  return forwardPhase3Mutation(request, {
    method: gateCAccessMachine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/access-passes`,
    body: {
      role: body.role,
      expires_at: body.expiresAt,
      idempotency_key: body.idempotencyKey,
    },
    validate: (value) => parseIssuedAccessPass(value) !== null,
    successStatus: 201,
  });
}
