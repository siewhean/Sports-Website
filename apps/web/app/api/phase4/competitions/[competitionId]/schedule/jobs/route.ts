import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";
import { parseScheduleJobEnvelope, phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";

export async function POST(request: NextRequest, { params }: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await params;
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, [phase4ScheduleMachine.idempotencyKeyField, phase4ScheduleMachine.expectedSourceRevisionField, phase4ScheduleMachine.expectedCapacityRevisionField, phase4ScheduleMachine.objectiveField, phase4ScheduleMachine.constraintsField]) || typeof body.idempotency_key !== "string" || !Number.isSafeInteger(body.expected_source_revision) || !Number.isSafeInteger(body.expected_capacity_revision) || ![phase4ScheduleMachine.fastest, phase4ScheduleMachine.balanced, phase4ScheduleMachine.restFocused].includes(String(body.objective) as never) || !body.constraints || typeof body.constraints !== "object" || Array.isArray(body.constraints)) return NextResponse.json({ error: { code: phase4ScheduleMachine.validationError, message: phase4ScheduleCopy.invalidCommand } }, { status: 400 });
  return forwardPhase3Mutation(request, { method: phase4ScheduleMachine.post, path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/schedule-jobs`, body, validate: (value) => parseScheduleJobEnvelope(value) !== null });
}
