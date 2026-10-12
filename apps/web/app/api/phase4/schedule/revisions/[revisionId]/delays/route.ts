import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { forwardPhase3Mutation, jsonBody } from "@/lib/phase3-settings-command.server";
import {
  isScheduleDelayBody,
  isScheduleDelayResponse,
  phase4ScheduleCopy,
  phase4ScheduleMachine,
} from "@/lib/phase4-schedule";

export async function POST(request: NextRequest, { params }: { params: Promise<{ revisionId: string }> }) {
  const { revisionId } = await params;
  const body = await jsonBody(request);
  if (!body || !isScheduleDelayBody(body))
    return NextResponse.json(
      { error: { code: phase4ScheduleMachine.validationError, message: phase4ScheduleCopy.invalidCommand } },
      { status: 400 },
    );
  return forwardPhase3Mutation(request, {
    method: phase4ScheduleMachine.post,
    path: `/api/v1/schedule-revisions/${encodeURIComponent(revisionId)}/delays`,
    body,
    validate: isScheduleDelayResponse,
    successStatus: 201,
  });
}
