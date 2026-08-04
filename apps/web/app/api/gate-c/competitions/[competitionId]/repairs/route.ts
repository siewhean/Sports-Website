import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { gateCC4BffMachine } from "@/lib/gate-c-c4-bff";
import { jsonBody, readPhase3Json, forwardPhase3Mutation } from "@/lib/phase3-settings-command.server";
import { parseGateCC4RepairQueue, parseGateCC4Workspace } from "@/lib/gate-c-c4";

export async function GET(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(request, `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs`);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: {
          code:
            result.status === 401 ? gateCC4BffMachine.errors.authRequired : gateCC4BffMachine.errors.repairReadFailed,
        },
      },
      { status: result.status },
    );
  }
  const queue = parseGateCC4RepairQueue(result.payload);
  return queue
    ? NextResponse.json(queue, {
        headers: { [gateCC4BffMachine.headers.cacheControl]: gateCC4BffMachine.cache.noStore },
      })
    : NextResponse.json({ error: { code: gateCC4BffMachine.errors.repairResponseInvalid } }, { status: 502 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const body = await jsonBody(request);
  if (!body || Object.keys(body).sort().join(",") !== gateCC4BffMachine.fields.correctionTransactionId) {
    return NextResponse.json({ error: { code: gateCC4BffMachine.errors.requestInvalid } }, { status: 400 });
  }
  return forwardPhase3Mutation(request, {
    method: gateCC4BffMachine.methods.post,
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/analyse`,
    body,
    validate: (value) => parseGateCC4Workspace(value) !== null,
  });
}
