import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCResultsCopy as copy, gateCResultsMachine as machine, parseResultConflict } from "@/lib/gate-c-results";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

const clientEventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; conflictId: string }> },
) {
  const { competitionId, conflictId } = await params;
  const body = await jsonBody(request);
  if (
    !body ||
    !hasExactKeys(body, machine.acknowledgementBodyKeys) ||
    typeof body.clientEventId !== "string" ||
    !clientEventIdPattern.test(body.clientEventId) ||
    typeof body.reason !== "string" ||
    body.reason.trim().length < 3 ||
    body.reason.length > 500 ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 1
  ) {
    return NextResponse.json(
      { error: { code: machine.acknowledgementInvalid, message: copy.acknowledgementInvalid } },
      { status: 400 },
    );
  }
  return forwardPhase3Mutation(request, {
    method: machine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/result-conflicts/${encodeURIComponent(conflictId)}/acknowledge`,
    body: {
      client_event_id: body.clientEventId,
      reason: body.reason.trim(),
      expected_revision: body.expectedRevision,
    },
    validate: (value) => parseResultConflict(value) !== null,
  });
}
