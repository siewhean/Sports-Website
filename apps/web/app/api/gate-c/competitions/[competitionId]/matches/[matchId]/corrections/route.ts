import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseFiveSportScoreCommand } from "@matchday/domain";
import {
  gateCResultsCopy as copy,
  gateCResultsMachine as machine,
  parseResultMutationReceipt,
} from "@/lib/gate-c-results";
import { forwardPhase3Mutation, hasExactKeys, jsonBody } from "@/lib/phase3-settings-command.server";

const commandKeys = new Set<string>(machine.commandKeys);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ competitionId: string; matchId: string }> },
) {
  const { competitionId, matchId } = await params;
  const body = await jsonBody(request);
  const events = body?.events;
  if (
    !body ||
    !hasExactKeys(body, machine.correctionBodyKeys) ||
    typeof body.clientEventId !== "string" ||
    typeof body.reason !== "string" ||
    body.reason.trim().length < 3 ||
    body.reason.length > 500 ||
    !Number.isSafeInteger(body.expectedAggregateVersion) ||
    Number(body.expectedAggregateVersion) < 0 ||
    !Array.isArray(events) ||
    events.length < 1 ||
    events.length > 25
  ) {
    return NextResponse.json(
      { error: { code: machine.correctionCommandInvalid, message: copy.correctionInvalid } },
      { status: 400 },
    );
  }
  if (
    events.some(
      (event) =>
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        Object.keys(event as Record<string, unknown>).some((key) => !commandKeys.has(key)) ||
        parseFiveSportScoreCommand(event) === null,
    )
  ) {
    return NextResponse.json(
      { error: { code: machine.correctionEventInvalid, message: copy.correctionEventInvalid } },
      { status: 400 },
    );
  }
  return forwardPhase3Mutation(request, {
    method: machine.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/corrections`,
    body: {
      client_event_id: body.clientEventId,
      reason: body.reason.trim(),
      expected_aggregate_version: body.expectedAggregateVersion,
      events,
    },
    validate: (value) => parseResultMutationReceipt(value) !== null,
  });
}
