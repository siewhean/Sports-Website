import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseGateCC4RepairQueue, parseGateCC4Workspace } from "@/lib/gate-c-c4";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import {
  forwardPhase3Mutation,
  jsonBody,
  readPhase3Json,
} from "@/lib/phase3-settings-command.server";

export async function GET(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs`,
  );
  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code:
            result.status === 401
              ? gateCC4Http.errors.authRequired
              : gateCC4Http.errors.repairReadFailed,
        },
      },
      { status: result.status },
    );
  }
  const queue = parseGateCC4RepairQueue(result.payload);
  return queue
    ? NextResponse.json(queue, {
        headers: { "cache-control": gateCC4Http.cacheNoStore },
      })
    : NextResponse.json(
        { error: { code: gateCC4Http.errors.repairResponseInvalid } },
        { status: 502 },
      );
}

export async function POST(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const body = await jsonBody(request);
  if (!body || Object.keys(body).sort().join(",") !== "correction_transaction_id") {
    return NextResponse.json(
      { error: { code: gateCC4Http.errors.requestInvalid } },
      { status: 400 },
    );
  }
  return forwardPhase3Mutation(request, {
    method: gateCC4Http.methodPost,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/analyse`,
    body,
    validate: (value) => parseGateCC4Workspace(value) !== null,
  });
}
