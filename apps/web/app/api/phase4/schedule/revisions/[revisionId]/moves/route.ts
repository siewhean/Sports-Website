import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";
import { isScheduleMoveResponse, phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";

const keys = [
  phase4ScheduleMachine.matchIdField,
  phase4ScheduleMachine.playingAreaIdField,
  phase4ScheduleMachine.slotIdField,
  phase4ScheduleMachine.startEpochField,
  phase4ScheduleMachine.endEpochField,
  phase4ScheduleMachine.idempotencyKeyField,
  phase4ScheduleMachine.expectedRevisionField,
] as const;

export async function POST(request: NextRequest, { params }: { params: Promise<{ revisionId: string }> }) {
  const { revisionId } = await params;
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, keys) ||
    ![
      phase4ScheduleMachine.matchIdField,
      phase4ScheduleMachine.playingAreaIdField,
      phase4ScheduleMachine.slotIdField,
      phase4ScheduleMachine.idempotencyKeyField,
    ].every((key) => typeof body[key] === "string" && body[key].length > 0) ||
    !Number.isSafeInteger(body.start_epoch_ms) ||
    !Number.isSafeInteger(body.end_epoch_ms) ||
    !Number.isSafeInteger(body.expected_revision)
  )
    return NextResponse.json(
      { error: { code: phase4ScheduleMachine.validationError, message: phase4ScheduleCopy.invalidCommand } },
      { status: 400 },
    );
  return forwardPhase3Mutation(request, {
    method: phase4ScheduleMachine.post,
    path: `/api/v1/schedule-revisions/${encodeURIComponent(revisionId)}/moves`,
    body,
    validate: isScheduleMoveResponse,
  });
}
