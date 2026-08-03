import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { jsonBody, readPhase3Json, forwardPhase3Mutation } from "@/lib/phase3-settings-command.server";
import { parseGateCC4RepairQueue, parseGateCC4Workspace } from "@/lib/gate-c-c4";

export async function GET(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(request, `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs`);
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.status === 401 ? "AUTH_REQUIRED" : "REPAIR_READ_FAILED" } },
      { status: result.status },
    );
  }
  const queue = parseGateCC4RepairQueue(result.payload);
  return queue
    ? NextResponse.json(queue, { headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: { code: "REPAIR_RESPONSE_INVALID" } }, { status: 502 });
}

export async function POST(request: NextRequest, context: { params: Promise<{ competitionId: string }> }) {
  const { competitionId } = await context.params;
  const body = await jsonBody(request);
  if (!body || Object.keys(body).sort().join(",") !== "correction_transaction_id") {
    return NextResponse.json({ error: { code: "REQUEST_INVALID" } }, { status: 400 });
  }
  return forwardPhase3Mutation(request, {
    method: "POST",
    path: `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/analyse`,
    body,
    validate: (value) => parseGateCC4Workspace(value) !== null,
  });
}
