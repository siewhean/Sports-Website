import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";
import { parseScheduleJobEnvelope, phase4ScheduleCopy, phase4ScheduleMachine } from "@/lib/phase4-schedule";

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const body = await jsonBody(request);
  if (!body || !hasExactKeys(body, [phase4ScheduleMachine.idempotencyKeyField, phase4ScheduleMachine.expectedRevisionField]) || typeof body.idempotency_key !== "string" || !Number.isSafeInteger(body.expected_revision)) return NextResponse.json({ error: { code: phase4ScheduleMachine.validationError, message: phase4ScheduleCopy.invalidCommand } }, { status: 400 });
  return forwardPhase3Mutation(request, { method: phase4ScheduleMachine.post, path: `/api/v1/schedule-jobs/${encodeURIComponent(jobId)}/continue`, body, validate: (value) => parseScheduleJobEnvelope(value) !== null });
}
