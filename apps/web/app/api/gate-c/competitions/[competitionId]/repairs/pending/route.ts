import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { parseGateCC4PendingRepairCases } from "@/lib/gate-c-c4-pending";
import { readPhase3Json } from "@/lib/phase3-settings-command.server";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ competitionId: string }> },
) {
  const { competitionId } = await context.params;
  const result = await readPhase3Json(
    request,
    `/api/v1/competitions/${encodeURIComponent(competitionId)}/repairs/pending`,
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: { code: result.status === 401 ? "AUTH_REQUIRED" : "REPAIR_INTAKE_READ_FAILED" } },
      { status: result.status },
    );
  }
  const pending = parseGateCC4PendingRepairCases(result.payload);
  return pending
    ? NextResponse.json(pending, { headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: { code: "REPAIR_INTAKE_RESPONSE_INVALID" } }, { status: 502 });
}
