import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";
import { isScheduleUnlockResponse, phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ revisionId: string; matchId: string }> },
) {
  const { revisionId, matchId } = await params;
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, [phase4ScheduleMachine.idempotencyKeyField]) ||
    typeof body.idempotency_key !== "string"
  )
    return NextResponse.json(
      { error: { code: phase4ScheduleMachine.validationError, message: phase4ScheduleCopy.invalidCommand } },
      { status: 400 },
    );
  return forwardPhase3Mutation(request, {
    method: phase4ScheduleMachine.delete,
    path: `/api/v1/schedule-revisions/${encodeURIComponent(revisionId)}/locks/${encodeURIComponent(matchId)}`,
    body,
    validate: isScheduleUnlockResponse,
  });
}
